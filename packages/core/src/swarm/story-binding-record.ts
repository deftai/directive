/**
 * Story-binding record store (#6379 / #7274).
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
 * Complete/remove acquire the store lock without waiting. Begin may pass
 * `lockWait` for a bounded retry on contention (#7274); dead-owner reclaim
 * is unchanged.
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
  /**
   * Originating checkout project root that owns the delivery-attempt ledger for
   * attempt_ids (#7270). Must be a checkout root, not a git-common-dir alone.
   */
  readonly begun_from?: string;
  /**
   * Per-attempt checkout roots when several checkouts share one record (#7270).
   * A later begin must not relabel an older attempt with its own root.
   */
  readonly attempt_begun_from?: Readonly<Record<string, string>>;
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

export const STORY_BINDING_STORE_LOCKED = "the story-binding record store is locked";

/** Default begin-facing wait: ~2s wall clock (40 × 50ms) unless maxWaitMs cuts short. */
export const STORY_BINDING_BEGIN_LOCK_MAX_ATTEMPTS = 40;
export const STORY_BINDING_BEGIN_LOCK_SLEEP_MS = 50;
export const STORY_BINDING_BEGIN_LOCK_MAX_WAIT_MS = 2_000;

export interface StoryBindingLockWait {
  readonly maxAttempts?: number;
  readonly sleepMs?: number;
  readonly maxWaitMs?: number;
  readonly sleep?: (ms: number) => void;
  readonly nowMs?: () => number;
}

export function isStoryBindingStoreLockedDetail(detail: string): boolean {
  return detail === STORY_BINDING_STORE_LOCKED || detail.includes(STORY_BINDING_STORE_LOCKED);
}

function defaultSleep(ms: number): void {
  if (ms <= 0) return;
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
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

function ticketRel(): string {
  return join(STORY_BINDING_STORE_DIR, `${STORY_BINDING_LOCK_NAME}.reclaim`);
}

function parseAttemptBegunFrom(raw: unknown): Record<string, string> | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.length === 0 || typeof value !== "string" || value.trim().length === 0) return null;
    out[key] = value.trim();
  }
  return out;
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
  const begunRaw = rec.begun_from;
  let begunFrom: string | undefined;
  if (begunRaw !== undefined) {
    if (typeof begunRaw !== "string" || begunRaw.trim().length === 0) return null;
    begunFrom = begunRaw.trim();
  }
  const owners = parseAttemptBegunFrom(rec.attempt_begun_from);
  if (owners === null) return null;
  return {
    story_id: storyId,
    worktree_path: worktreePath,
    attempt_ids: [...(ids as string[])],
    ...(begunFrom !== undefined ? { begun_from: begunFrom } : {}),
    ...(owners !== undefined ? { attempt_begun_from: owners } : {}),
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

/**
 * Run `body` under the one record-store lock (#6379 item 5).
 * When `wait` is set, retry acquire until attempts or wall-clock budget end (#7274).
 */
function withStoreLock<T>(
  commonDir: string,
  body: () => T,
  wait?: StoryBindingLockWait,
): T | { readonly ok: false; readonly detail: string } {
  const maxAttempts = wait === undefined ? 1 : (wait.maxAttempts ?? STORY_BINDING_BEGIN_LOCK_MAX_ATTEMPTS);
  const sleepMs = wait?.sleepMs ?? STORY_BINDING_BEGIN_LOCK_SLEEP_MS;
  const maxWaitMs = wait?.maxWaitMs ?? STORY_BINDING_BEGIN_LOCK_MAX_WAIT_MS;
  const sleep = wait?.sleep ?? defaultSleep;
  const nowMs = wait?.nowMs ?? Date.now;
  const started = nowMs();
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const token = acquireLock(commonDir);
    if (token !== null) {
      try {
        return body();
      } finally {
        removeIfOurs(commonDir, lockRel(), token);
      }
    }
    if (attempt >= maxAttempts) break;
    if (nowMs() - started >= maxWaitMs) break;
    sleep(sleepMs);
  }
  return { ok: false, detail: STORY_BINDING_STORE_LOCKED };
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
   * Originating checkout project root that owns the delivery-attempt ledger for
   * `attemptIds` (#7270). Not a git-common-dir alone.
   */
  readonly begunFrom?: string;
  /**
   * Called under the store lock: returns the ids among those given that a
   * ledger known to the caller shows as ended. They are dropped from the new
   * ids and from the ids the record already lists, so an attempt that ended
   * between begin's ledger read and this write is never written back, and an
   * ended id whose removal found the store locked is pruned at the next begin.
   * An id the caller's ledgers do not know (another checkout's attempt) is
   * kept: absence is not proof that it ended.
   */
  readonly endedAttemptIds?: (attemptIds: readonly string[]) => readonly string[];
  /**
   * Begin-facing bounded wait on store-lock contention (#7274). Omit for
   * complete/remove and other non-waiting callers.
   */
  readonly lockWait?: StoryBindingLockWait;
}

/**
 * Write or update the worktree's record. A record for the same story keeps its
 * other attempt ids (except ids known to have ended); a record for a different
 * story (or a malformed one) is replaced with only the given ids.
 */
export function ensureStoryBindingRecord(
  input: EnsureStoryBindingRecordInput,
): EnsureStoryBindingRecordResult {
  const rel = recordRel(storyBindingRecordName(input.worktreePath));
  return withStoreLock(
    input.commonDir,
    (): EnsureStoryBindingRecordResult => {
      const existing = loadRecordFile(join(input.commonDir, rel));
      const sameStory = typeof existing === "object" && existing.story_id === input.storyId;
      const kept = sameStory ? existing.attempt_ids : [];
      const candidates = [...new Set([...kept, ...input.attemptIds])];
      const ended = new Set(input.endedAttemptIds?.(candidates) ?? []);
      if (input.attemptIds.every((id) => ended.has(id))) {
        return { ok: false, detail: "no attempt of this unit is still running" };
      }
      const attemptIds = candidates.filter((id) => !ended.has(id));
      const begunFrom = input.begunFrom?.trim() ?? "";
      const priorOwners =
        sameStory && existing.attempt_begun_from !== undefined
          ? { ...existing.attempt_begun_from }
          : sameStory && existing.begun_from !== undefined
            ? Object.fromEntries(kept.map((id) => [id, existing.begun_from as string]))
            : {};
      const owners: Record<string, string> = {};
      for (const id of attemptIds) {
        const prior = priorOwners[id]?.trim() ?? "";
        if (prior.length > 0) {
          owners[id] = prior;
        } else if (begunFrom.length > 0) {
          owners[id] = begunFrom;
        }
      }
      const record: StoryBindingRecord = {
        story_id: input.storyId,
        worktree_path: input.worktreePath,
        attempt_ids: attemptIds,
        ...(begunFrom.length > 0 ? { begun_from: begunFrom } : {}),
        ...(Object.keys(owners).length > 0 ? { attempt_begun_from: owners } : {}),
      };
      const failed = writeRecordAtomic(input.commonDir, rel, record);
      if (failed !== null) {
        return { ok: false, detail: `story-binding record write failed: ${failed}` };
      }
      return { ok: true, record };
    },
    input.lockWait,
  );
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
