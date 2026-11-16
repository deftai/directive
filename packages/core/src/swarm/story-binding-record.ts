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
 *
 * The store lock does not wait, like the delivery-attempt unit lock: a live
 * holder makes the write report "locked", and begin prints that as its one
 * `story-binding:` line (a repeat begin writes a missing record).
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { containedRemove, containedWrite } from "../fs/contained-write.js";
import { defaultGitRunner, type GitRunner, gitCommonDir } from "../session/git.js";
import {
  FAILURE_MALFORMED_ASSIGNMENT,
  resolveWorkerAuthDestPath,
} from "./worker-auth-assignment.js";

export const STORY_BINDING_STORE_DIR = "deft-story-binding";
export const STORY_BINDING_LOCK_NAME = "store.lock";
/**
 * A lock or reclaim ticket whose owner cannot be read is reclaimed after five
 * minutes: far longer than any begin/complete holds the lock (milliseconds),
 * short enough that a crashed writer does not block the next begin for long.
 */
export const STORY_BINDING_LOCK_STALE_MS = 300_000;

export interface StoryBindingRecord {
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

const STORE_LOCKED = "the story-binding record store is locked";

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

function ticketRel(): string {
  return join(STORY_BINDING_STORE_DIR, `${STORY_BINDING_LOCK_NAME}.reclaim`);
}

function parseRecord(raw: unknown): StoryBindingRecord | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const storyId = typeof rec.story_id === "string" ? rec.story_id.trim() : "";
  const worktreePath = typeof rec.worktree_path === "string" ? rec.worktree_path : "";
  const ids = rec.attempt_ids;
  if (storyId.length === 0 || worktreePath.length === 0) return null;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || id.length === 0)) {
    return null;
  }
  return { story_id: storyId, worktree_path: worktreePath, attempt_ids: [...(ids as string[])] };
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

function readOwnerFile(abs: string): LockOwner | null {
  try {
    const raw = JSON.parse(readFileSync(abs, "utf8")) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const rec = raw as Record<string, unknown>;
    if (typeof rec.pid !== "number" || typeof rec.token !== "string") return null;
    return { pid: rec.pid, token: rec.token };
  } catch {
    return null;
  }
}

function fileIsStale(abs: string): boolean {
  try {
    return Date.now() - lstatSync(abs).mtimeMs >= STORY_BINDING_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/** True when the file exists and its owner is dead, or it is unreadable and stale. */
function ownerFileIsReclaimable(abs: string): boolean {
  if (!existsSync(abs)) return false;
  const owner = readOwnerFile(abs);
  return owner !== null ? !isProcessAlive(owner.pid) : fileIsStale(abs);
}

function createOwnerFile(commonDir: string, rel: string, token: string): boolean {
  try {
    containedWrite({
      root: commonDir,
      target: rel,
      data: `${JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })}\n`,
      mode: "create",
    });
    return true;
  } catch {
    // Already held (CONTAINED_WRITE_EXISTS) or not writable: not taken.
    return false;
  }
}

function removeIfOurs(commonDir: string, rel: string, token: string): void {
  const owner = readOwnerFile(join(commonDir, rel));
  if (owner === null || owner.token !== token || owner.pid !== process.pid) return;
  containedRemove({ root: commonDir, target: rel });
}

/**
 * Remove a dead or stale lock. Reclaimers serialize through one exclusive
 * reclaim ticket and re-check the lock under it, so a delayed reclaimer cannot
 * remove a live replacement lock. A ticket whose owner is dead, or that is
 * unreadable and stale, is removed first.
 */
function reclaimLock(commonDir: string): void {
  const token = randomUUID();
  if (!createOwnerFile(commonDir, ticketRel(), token)) {
    if (!ownerFileIsReclaimable(join(commonDir, ticketRel()))) return;
    try {
      containedRemove({ root: commonDir, target: ticketRel() });
    } catch {
      return;
    }
    if (!createOwnerFile(commonDir, ticketRel(), token)) return;
  }
  try {
    if (ownerFileIsReclaimable(join(commonDir, lockRel()))) {
      containedRemove({ root: commonDir, target: lockRel() });
    }
  } catch {
    // The lock is already gone.
  } finally {
    removeIfOurs(commonDir, ticketRel(), token);
  }
}

/** Take the store lock without waiting; a dead holder's lock is reclaimed once. */
function acquireLock(commonDir: string): string | null {
  const token = randomUUID();
  if (createOwnerFile(commonDir, lockRel(), token)) return token;
  if (!ownerFileIsReclaimable(join(commonDir, lockRel()))) return null;
  reclaimLock(commonDir);
  return createOwnerFile(commonDir, lockRel(), token) ? token : null;
}

/** Run `body` under the one record-store lock (#6379 item 5). */
function withStoreLock<T>(
  commonDir: string,
  body: () => T,
): T | { readonly ok: false; readonly detail: string } {
  const token = acquireLock(commonDir);
  if (token === null) return { ok: false, detail: STORE_LOCKED };
  try {
    return body();
  } finally {
    removeIfOurs(commonDir, lockRel(), token);
  }
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Write a record through a temporary file and rename it, so readers never see
 * a partial record. Returns an error detail, or null on success.
 */
function writeRecordAtomic(
  commonDir: string,
  rel: string,
  record: StoryBindingRecord,
): string | null {
  const tmpRel = `${rel}.tmp.${randomUUID()}`;
  try {
    containedWrite({
      root: commonDir,
      target: tmpRel,
      data: `${JSON.stringify(record, null, 2)}\n`,
      mode: "create",
    });
    renameSync(join(commonDir, tmpRel), join(commonDir, rel));
    return null;
  } catch (err) {
    try {
      if (existsSync(join(commonDir, tmpRel))) containedRemove({ root: commonDir, target: tmpRel });
    } catch {
      // Leave a stray temporary file; readers ignore it.
    }
    return errorDetail(err);
  }
}

export interface EnsureStoryBindingRecordInput {
  readonly commonDir: string;
  /** Canonical worktree path (see `resolveWorkerAuthDestPath`). */
  readonly worktreePath: string;
  readonly storyId: string;
  readonly attemptIds: readonly string[];
  /**
   * Called under the store lock: returns the ids that are still running. An
   * attempt that ended between begin's ledger read and this write is dropped,
   * so a record never regains an ended attempt (removal runs after the ledger
   * marks an attempt ended, under the same lock).
   */
  readonly stillRunning?: (attemptIds: readonly string[]) => readonly string[];
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
  return withStoreLock(input.commonDir, (): EnsureStoryBindingRecordResult => {
    const running = input.stillRunning?.(input.attemptIds) ?? input.attemptIds;
    if (running.length === 0) {
      return { ok: false, detail: "no attempt of this unit is still running" };
    }
    const existing = loadRecordFile(join(input.commonDir, rel));
    const kept =
      typeof existing === "object" && existing.story_id === input.storyId
        ? existing.attempt_ids
        : [];
    const record: StoryBindingRecord = {
      story_id: input.storyId,
      worktree_path: input.worktreePath,
      attempt_ids: [...new Set([...kept, ...running])],
    };
    const failed = writeRecordAtomic(input.commonDir, rel, record);
    if (failed !== null) {
      return { ok: false, detail: `story-binding record write failed: ${failed}` };
    }
    return { ok: true, record };
  });
}

export interface RemoveStoryBindingAttemptsInput {
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
  return withStoreLock(input.commonDir, (): RemoveStoryBindingAttemptsResult => {
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
        const failed = writeRecordAtomic(input.commonDir, recordRel(name), {
          ...loaded,
          attempt_ids: left,
        });
        if (failed !== null) {
          return { ok: false, detail: `story-binding record removal failed: ${failed}` };
        }
        updated.push(loaded.worktree_path);
      }
    } catch (err) {
      return { ok: false, detail: `story-binding record removal failed: ${errorDetail(err)}` };
    }
    return { ok: true, updated, deleted };
  });
}
