/**
 * Story-binding record store (#6379).
 *
 * `swarm:pre-dispatch` begin writes one record per linked worktree under
 * `<git-common-dir>/deft-story-binding/`. A record names the worktree's story
 * and lists the delivery attempts that use it. It holds no auth field: the
 * worker-auth reader and `requireScmReady` never read this store, so a record
 * changes story selection only, never GitHub auth.
 *
 * Like the worker-auth registry this store is cooperative: a same-user process
 * can change it. A self-written record can only select another active brief,
 * whose `file_scope` still comes from the merge base.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { ContainedWriteError, containedRemove, containedWrite } from "../fs/contained-write.js";
import { defaultGitRunner, type GitRunner, gitCommonDir } from "../session/git.js";
import {
  FAILURE_MALFORMED_ASSIGNMENT,
  resolveWorkerAuthDestPath,
} from "./worker-auth-assignment.js";

export const STORY_BINDING_STORE_DIR = "deft-story-binding";
export const STORY_BINDING_LOCK_NAME = "store.lock";
export const STORY_BINDING_SCHEMA_VERSION = 1;
/** A lock file older than this whose owner cannot be read may be reclaimed. */
export const STORY_BINDING_LOCK_STALE_MS = 5 * 60 * 1000;
/** Default wait for a live lock holder before a write gives up. */
export const STORY_BINDING_LOCK_WAIT_MS = 5000;
const LOCK_POLL_MS = 25;

export interface StoryBindingRecord {
  readonly schema_version: number;
  readonly story_id: string;
  readonly worktree_path: string;
  readonly attempt_ids: readonly string[];
}

export type ReadStoryBindingRecordResult =
  | {
      readonly ok: true;
      readonly record: StoryBindingRecord | null;
      readonly commonDir: string | null;
    }
  | { readonly ok: false; readonly failureKind: string; readonly detail: string };

export type EnsureStoryBindingRecordResult =
  | { readonly ok: true; readonly record: StoryBindingRecord }
  | { readonly ok: false; readonly detail: string };

export type RemoveStoryBindingAttemptsResult =
  | { readonly ok: true; readonly updated: readonly string[]; readonly deleted: readonly string[] }
  | { readonly ok: false; readonly detail: string };

export interface StoryBindingLockOptions {
  /** How long a write waits for a live lock holder (default {@link STORY_BINDING_LOCK_WAIT_MS}). */
  readonly lockWaitMs?: number;
}

function samePath(left: string, right: string): boolean {
  if (process.platform === "win32") return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

/** Record file name for a canonical worktree path (case-folded on Windows). */
export function storyBindingRecordName(canonicalPath: string): string {
  const key = process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
  return `${createHash("sha256").update(key).digest("hex")}.json`;
}

function recordRel(name: string): string {
  return join(STORY_BINDING_STORE_DIR, name);
}

function lockRel(): string {
  return join(STORY_BINDING_STORE_DIR, STORY_BINDING_LOCK_NAME);
}

function parseRecord(raw: unknown): StoryBindingRecord | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const storyId = typeof rec.story_id === "string" ? rec.story_id.trim() : "";
  const worktreePath = typeof rec.worktree_path === "string" ? rec.worktree_path : "";
  const ids = rec.attempt_ids;
  if (typeof rec.schema_version !== "number" || storyId.length === 0 || worktreePath.length === 0) {
    return null;
  }
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || id.length === 0)) {
    return null;
  }
  return {
    schema_version: rec.schema_version,
    story_id: storyId,
    worktree_path: worktreePath,
    attempt_ids: [...(ids as string[])],
  };
}

function loadRecordFile(abs: string): StoryBindingRecord | "missing" | "malformed" {
  if (!existsSync(abs)) return "missing";
  try {
    const parsed = parseRecord(JSON.parse(readFileSync(abs, "utf8")) as unknown);
    return parsed ?? "malformed";
  } catch {
    return "malformed";
  }
}

/**
 * Read the story-binding record for the worktree that contains `cwd`.
 * No record (or no Git common directory) is `record: null`; an unreadable or
 * malformed record is a failure the binding resolver refuses on.
 */
export function readStoryBindingRecord(
  cwd: string,
  commonDirHint: string | null = null,
  runGit: GitRunner = defaultGitRunner,
): ReadStoryBindingRecordResult {
  const commonDir = commonDirHint ?? gitCommonDir(cwd, runGit);
  if (commonDir === null) return { ok: true, record: null, commonDir: null };
  const canonical = resolveWorkerAuthDestPath(cwd, runGit);
  const loaded = loadRecordFile(join(commonDir, recordRel(storyBindingRecordName(canonical))));
  if (loaded === "missing") return { ok: true, record: null, commonDir };
  if (loaded === "malformed" || !samePath(loaded.worktree_path, canonical)) {
    return {
      ok: false,
      failureKind: FAILURE_MALFORMED_ASSIGNMENT,
      detail: `story-binding record is malformed for ${canonical}`,
    };
  }
  return { ok: true, record: loaded, commonDir };
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface LockOwner {
  readonly pid: number;
  readonly token: string;
}

function readLockOwner(commonDir: string): LockOwner | null {
  try {
    const raw = JSON.parse(readFileSync(join(commonDir, lockRel()), "utf8")) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const rec = raw as Record<string, unknown>;
    if (typeof rec.pid !== "number" || typeof rec.token !== "string") return null;
    return { pid: rec.pid, token: rec.token };
  } catch {
    return null;
  }
}

function lockIsStale(commonDir: string): boolean {
  try {
    const age = Date.now() - lstatSync(join(commonDir, lockRel())).mtimeMs;
    return age >= STORY_BINDING_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Move a dead or stale lock aside, only if it is still the lock that was inspected. */
function reclaimLock(commonDir: string, inspected: LockOwner | null): void {
  const current = readLockOwner(commonDir);
  const same =
    inspected === null
      ? current === null
      : current !== null && current.pid === inspected.pid && current.token === inspected.token;
  if (!same) return;
  const aside = join(STORY_BINDING_STORE_DIR, `${STORY_BINDING_LOCK_NAME}.reclaim.${randomUUID()}`);
  try {
    renameSync(join(commonDir, lockRel()), join(commonDir, aside));
    containedRemove({ root: commonDir, target: aside });
  } catch {
    // Lost the race, or the lock is already gone.
  }
}

function acquireLock(commonDir: string, waitMs: number): string | null {
  const token = randomUUID();
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      containedWrite({
        root: commonDir,
        target: lockRel(),
        data: `${JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })}\n`,
        mode: "create",
      });
      return token;
    } catch (err) {
      if (!(err instanceof ContainedWriteError && err.code === "CONTAINED_WRITE_EXISTS")) {
        return null;
      }
    }
    const owner = readLockOwner(commonDir);
    if (owner !== null ? !isProcessAlive(owner.pid) : lockIsStale(commonDir)) {
      reclaimLock(commonDir, owner);
      continue;
    }
    if (Date.now() >= deadline) return null;
    sleepSync(LOCK_POLL_MS);
  }
}

function releaseLock(commonDir: string, token: string): void {
  const owner = readLockOwner(commonDir);
  if (owner === null || owner.token !== token || owner.pid !== process.pid) return;
  containedRemove({ root: commonDir, target: lockRel() });
}

/** Run `body` under the one record-store lock (#6379 item 5). */
function withStoreLock<T>(
  commonDir: string,
  options: StoryBindingLockOptions,
  body: () => T,
): T | { readonly ok: false; readonly detail: string } {
  const token = acquireLock(commonDir, options.lockWaitMs ?? STORY_BINDING_LOCK_WAIT_MS);
  if (token === null) {
    return { ok: false, detail: "the story-binding record store is locked" };
  }
  try {
    return body();
  } finally {
    releaseLock(commonDir, token);
  }
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface EnsureStoryBindingRecordInput extends StoryBindingLockOptions {
  readonly commonDir: string;
  /** Canonical worktree path (see `resolveWorkerAuthDestPath`). */
  readonly worktreePath: string;
  readonly storyId: string;
  readonly attemptIds: readonly string[];
}

/**
 * Write or update the worktree's record. A record for the same story keeps its
 * other attempt ids; a record for a different story (or a malformed one) is
 * replaced with only the given ids.
 */
export function ensureStoryBindingRecord(
  input: EnsureStoryBindingRecordInput,
): EnsureStoryBindingRecordResult {
  const rel = recordRel(storyBindingRecordName(input.worktreePath));
  return withStoreLock(input.commonDir, input, (): EnsureStoryBindingRecordResult => {
    const existing = loadRecordFile(join(input.commonDir, rel));
    const kept =
      typeof existing === "object" && existing.story_id === input.storyId
        ? existing.attempt_ids
        : [];
    const record: StoryBindingRecord = {
      schema_version: STORY_BINDING_SCHEMA_VERSION,
      story_id: input.storyId,
      worktree_path: input.worktreePath,
      attempt_ids: [...new Set([...kept, ...input.attemptIds])],
    };
    try {
      containedWrite({
        root: input.commonDir,
        target: rel,
        data: `${JSON.stringify(record, null, 2)}\n`,
        mode: "replace",
      });
    } catch (err) {
      return { ok: false, detail: `story-binding record write failed: ${errorDetail(err)}` };
    }
    return { ok: true, record };
  });
}

export interface RemoveStoryBindingAttemptsInput extends StoryBindingLockOptions {
  readonly commonDir: string;
  readonly attemptIds: readonly string[];
}

/**
 * Remove ended attempt ids from every record that lists them, and delete a
 * record whose list is then empty. Finds records by attempt id in the store;
 * it resolves no target and reads no ledger (#6379 item 5).
 */
export function removeStoryBindingAttempts(
  input: RemoveStoryBindingAttemptsInput,
): RemoveStoryBindingAttemptsResult {
  const ended = new Set(input.attemptIds);
  if (ended.size === 0) return { ok: true, updated: [], deleted: [] };
  const storeAbs = join(input.commonDir, STORY_BINDING_STORE_DIR);
  if (!existsSync(storeAbs)) return { ok: true, updated: [], deleted: [] };
  return withStoreLock(input.commonDir, input, (): RemoveStoryBindingAttemptsResult => {
    const updated: string[] = [];
    const deleted: string[] = [];
    try {
      for (const name of readdirSync(storeAbs)) {
        if (!name.endsWith(".json")) continue;
        const loaded = loadRecordFile(join(storeAbs, name));
        if (typeof loaded !== "object") continue;
        if (!loaded.attempt_ids.some((id) => ended.has(id))) continue;
        const left = loaded.attempt_ids.filter((id) => !ended.has(id));
        if (left.length === 0) {
          containedRemove({ root: input.commonDir, target: recordRel(name) });
          deleted.push(loaded.worktree_path);
          continue;
        }
        containedWrite({
          root: input.commonDir,
          target: recordRel(name),
          data: `${JSON.stringify({ ...loaded, attempt_ids: left }, null, 2)}\n`,
          mode: "replace",
        });
        updated.push(loaded.worktree_path);
      }
    } catch (err) {
      return { ok: false, detail: `story-binding record removal failed: ${errorDetail(err)}` };
    }
    return { ok: true, updated, deleted };
  });
}
