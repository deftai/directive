/**
 * Same-worktree sidecar lock for `.deft/plan-sequence.json` (#3907).
 *
 * Reuses the #3909 directory-rename protocol (non-empty claim rename, dead-PID
 * reap only). Does not call the PROJECT-DEFINITION lock. Lock-busy, reentrancy,
 * short owner writes, and unexpected filesystem errno are returned-failure
 * (caller may retry).
 */
import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { containedWrite } from "../fs/contained-write.js";

export type ProcessLiveness = "dead" | "alive" | "unknown";

export type PlanSequenceLockBlockedReason =
  | "contended"
  | "owner-alive"
  | "owner-liveness-unknown"
  | "malformed-lock-directory"
  | "legacy-file-sidecar";

const LOCK_OWNER_ENTRY_RE = /^([1-9]\d*)-([a-f0-9]{32})$/;
const RENAME_CONTENTION_CODES = new Set([
  "EACCES",
  "EEXIST",
  "EISDIR",
  "ENOTDIR",
  "ENOTEMPTY",
  "EPERM",
]);

const mutationThreadLock = { held: false };
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

function defaultSleep(ms: number): void {
  Atomics.wait(sleepCell, 0, 0, ms);
}

export interface PlanSequenceLockDeps {
  readonly sleepMs?: (ms: number) => void;
  readonly monotonicNowMs?: () => number;
  readonly acquisitionBudgetMs?: number;
  readonly probeProcess?: (pid: number) => ProcessLiveness;
  readonly writeOwner?: (fd: number, payload: string) => number;
  readonly renameLock?: (source: string, destination: string) => void;
  readonly beforeLockDirRemove?: (lockPath: string) => void;
}

export type PlanSequenceLockResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: "lock-timeout" | "lock-reentrant";
      readonly message: string;
    };

function defaultProbeProcess(pid: number): ProcessLiveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}

function lstatIfExists(path: string): Stats | null {
  return lstatSync(path, { throwIfNoEntry: false }) ?? null;
}

interface DirectoryLockOwner {
  readonly pid: number;
  readonly token: string;
  readonly entryName: string;
}

function parseDirectoryLockOwnerEntry(entryName: string): DirectoryLockOwner | null {
  const match = LOCK_OWNER_ENTRY_RE.exec(entryName);
  if (match === null) return null;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || match[2] === undefined) return null;
  return { pid, token: match[2], entryName };
}

function readDirectoryLockOwner(lockPath: string): DirectoryLockOwner | null {
  let entries: string[];
  try {
    entries = readdirSync(lockPath);
  } catch {
    return null;
  }
  if (entries.length !== 1) return null;
  return parseDirectoryLockOwnerEntry(entries[0] ?? "");
}

type ReapOutcome = { reaped: true } | { reaped: false; reason: PlanSequenceLockBlockedReason };

function reapDirectoryLock(
  lockPath: string,
  probeProcess: (pid: number) => ProcessLiveness,
  beforeLockDirRemove: (lockPath: string) => void,
): ReapOutcome {
  const owner = readDirectoryLockOwner(lockPath);
  if (owner === null) {
    return { reaped: false, reason: "malformed-lock-directory" };
  }
  const liveness = probeProcess(owner.pid);
  if (liveness === "alive") return { reaped: false, reason: "owner-alive" };
  if (liveness === "unknown") return { reaped: false, reason: "owner-liveness-unknown" };

  try {
    unlinkSync(join(lockPath, owner.entryName));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { reaped: false, reason: "contended" };
    }
    return { reaped: false, reason: "malformed-lock-directory" };
  }
  beforeLockDirRemove(lockPath);
  try {
    rmdirSync(lockPath);
    return { reaped: true };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { reaped: true };
    if (code === "ENOTEMPTY" || code === "EEXIST") {
      return { reaped: false, reason: "contended" };
    }
    return { reaped: false, reason: "malformed-lock-directory" };
  }
}

function describeLockFailure(
  lockPath: string,
  reason: PlanSequenceLockBlockedReason,
  budgetMs: number,
): string {
  const sidecarName = basename(lockPath);
  const header = `timed out acquiring the plan-sequence mutation lock after ${budgetMs}ms (blocked by: ${reason}).`;
  if (reason === "legacy-file-sidecar") {
    return [
      header,
      "A legacy single-file lock sidecar holds the public lock pathname.",
      `Remove the '${sidecarName}' sidecar beside plan-sequence.json after confirming no mutator is running.`,
    ].join("\n");
  }
  if (reason === "malformed-lock-directory" || reason === "owner-liveness-unknown") {
    return [
      header,
      "The lock state cannot be attributed to a known owner.",
      `Remove the '${sidecarName}' lock directory beside plan-sequence.json after confirming no mutator is running.`,
    ].join("\n");
  }
  return [
    header,
    "Another plan-sequence mutation still holds the lock. Retry once it completes.",
  ].join("\n");
}

function lockBusy(message: string): PlanSequenceLockResult<never> {
  return { ok: false, code: "lock-timeout", message };
}

/**
 * Run `fn` while holding the exclusive sidecar directory lock beside the
 * plan-sequence file. Returned-failure for timeout, reentrancy, short owner
 * writes, and unexpected filesystem errno.
 */
export function withPlanSequenceSidecarLock<T>(
  lockPath: string,
  fn: () => T,
  deps: PlanSequenceLockDeps = {},
): PlanSequenceLockResult<T> {
  if (mutationThreadLock.held) {
    return {
      ok: false,
      code: "lock-reentrant",
      message: "plan-sequence mutation lock is not reentrant",
    };
  }
  const sleepMs = deps.sleepMs ?? defaultSleep;
  const monotonicNowMs = deps.monotonicNowMs ?? (() => performance.now());
  const budgetMs = deps.acquisitionBudgetMs ?? 30_000;
  const probeProcess = deps.probeProcess ?? defaultProbeProcess;
  const writeOwner = deps.writeOwner;
  const renameLock = deps.renameLock ?? renameSync;
  const beforeLockDirRemove = deps.beforeLockDirRemove ?? (() => undefined);

  mutationThreadLock.held = true;
  let ownerEntryPath: string | undefined;
  let ownerToken: string | undefined;
  let preparedEntryPath: string | undefined;
  let preparedLockPath: string | undefined;
  let acquired = false;
  try {
    try {
      mkdirSync(dirname(lockPath), { recursive: true });
      ownerToken = randomBytes(16).toString("hex");
      const ownerEntryName = `${process.pid}-${ownerToken}`;
      const preparedPath = `${lockPath}.claim-${ownerEntryName}`;
      preparedLockPath = preparedPath;
      preparedEntryPath = join(preparedPath, ownerEntryName);
      mkdirSync(preparedPath);
      const payload = `${JSON.stringify({ pid: process.pid, token: ownerToken })}\n`;
      try {
        if (writeOwner !== undefined) {
          const written = writeOwner(-1, payload);
          if (written !== Buffer.byteLength(payload)) {
            return lockBusy("short write while recording plan-sequence lock owner");
          }
        } else {
          containedWrite({
            root: dirname(dirname(lockPath)),
            target: preparedEntryPath,
            data: payload,
            mode: "create",
          });
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return lockBusy(`plan-sequence lock owner record failed: ${detail}`);
      }

      const startedAt = monotonicNowMs();
      const expired = (): boolean => monotonicNowMs() - startedAt >= budgetMs;
      const yieldOrFail = (_reason: PlanSequenceLockBlockedReason): boolean => {
        if (expired()) {
          return true;
        }
        sleepMs(20);
        return false;
      };

      let timeoutReason: PlanSequenceLockBlockedReason | undefined;
      while (true) {
        const existing = lstatIfExists(lockPath);
        if (existing !== null && !existing.isDirectory()) {
          if (yieldOrFail("legacy-file-sidecar")) {
            timeoutReason = "legacy-file-sidecar";
            break;
          }
          continue;
        }
        try {
          renameLock(preparedPath, lockPath);
          acquired = true;
          preparedLockPath = undefined;
          preparedEntryPath = undefined;
          ownerEntryPath = join(lockPath, ownerEntryName);
          break;
        } catch (err: unknown) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === undefined || !RENAME_CONTENTION_CODES.has(code)) {
            const detail = err instanceof Error ? err.message : String(err);
            return lockBusy(`plan-sequence lock publish failed: ${detail}`);
          }
          const lockStat = lstatIfExists(lockPath);
          if (lockStat === null) {
            if (code === "EACCES" || code === "EPERM") {
              const detail = err instanceof Error ? err.message : String(err);
              return lockBusy(`plan-sequence lock publish failed: ${detail}`);
            }
            continue;
          }
          if (lockStat.isDirectory()) {
            const outcome = reapDirectoryLock(lockPath, probeProcess, beforeLockDirRemove);
            if (outcome.reaped) continue;
            if (yieldOrFail(outcome.reason)) {
              timeoutReason = outcome.reason;
              break;
            }
            continue;
          }
          if (yieldOrFail("legacy-file-sidecar")) {
            timeoutReason = "legacy-file-sidecar";
            break;
          }
        }
      }
      if (!acquired) {
        return lockBusy(describeLockFailure(lockPath, timeoutReason ?? "contended", budgetMs));
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return lockBusy(`plan-sequence lock setup failed: ${detail}`);
    }
    return { ok: true, value: fn() };
  } finally {
    try {
      if (acquired) {
        try {
          if (ownerEntryPath !== undefined && ownerToken !== undefined) {
            const current = readDirectoryLockOwner(lockPath);
            if (
              current?.token === ownerToken &&
              join(lockPath, current.entryName) === ownerEntryPath
            ) {
              unlinkSync(ownerEntryPath);
              rmdirSync(lockPath);
            }
          }
        } catch {
          /* best-effort */
        }
      } else {
        try {
          if (preparedEntryPath !== undefined) unlinkSync(preparedEntryPath);
        } catch {
          /* best-effort */
        }
        try {
          if (preparedLockPath !== undefined) rmdirSync(preparedLockPath);
        } catch {
          /* best-effort */
        }
      }
    } finally {
      mutationThreadLock.held = false;
    }
  }
}
