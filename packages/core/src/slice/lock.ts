import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { assertWriteTargetSafe } from "../fs/projection-containment.js";

const threadLocked = { held: false };
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/** 10× occupancy heartbeat TTL. Off-Linux PID reuse / stalled holder reclaim. */
export const STALE_LOCK_HARD_CAP_MS = 20 * 60 * 1000 * 10;

/** Default wait before timed out acquiring lock. Overridable per call (#3872). */
export const DEFAULT_ACQUISITION_BUDGET_MS = 30_000;

export interface LockDeps {
  readonly sleepMs?: (ms: number) => void;
  readonly now?: () => number;
  /** Total acquisition budget in milliseconds. Default {@link DEFAULT_ACQUISITION_BUDGET_MS}. */
  readonly acquisitionBudgetMs?: number;
  /**
   * When set, lock and reclaim paths must stay inside this project root
   * (same containment assertion as the JSON record they serialize).
   */
  readonly containmentRoot?: string;
}

export interface HeldLock {
  readonly lockPath: string;
  readonly pid: number;
  readonly token: string;
  readonly acquiredAt: number;
}

export interface LockRecord {
  readonly pid: number | null;
  readonly token: string;
  readonly acquiredAt: number | null;
}

function defaultSleep(ms: number): void {
  Atomics.wait(sleepCell, 0, 0, ms);
}

export function parseLockRecord(lockPath: string): LockRecord {
  try {
    const lines = readFileSync(lockPath, { encoding: "utf8" }).trim().split(/\r?\n/);
    const pidRaw = Number(lines[0]);
    const pid = Number.isInteger(pidRaw) && pidRaw > 0 ? pidRaw : null;
    if (lines.length >= 3) {
      const acquiredRaw = Number(lines[2]);
      return {
        pid,
        token: lines[1] ?? "",
        acquiredAt: Number.isInteger(acquiredRaw) && acquiredRaw > 0 ? acquiredRaw : null,
      };
    }
    const acquiredRaw = Number(lines[1]);
    return {
      pid,
      token: "",
      acquiredAt: Number.isInteger(acquiredRaw) && acquiredRaw > 0 ? acquiredRaw : null,
    };
  } catch {
    return { pid: null, token: "", acquiredAt: null };
  }
}

export function assertAppendLockOwned(held: HeldLock): void {
  const rec = parseLockRecord(held.lockPath);
  if (rec.pid !== held.pid || rec.token !== held.token || rec.token.length === 0) {
    throw new Error(`lock compromised: ${held.lockPath}`);
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function linuxPidStartedAfter(pid: number, acquiredAt: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, { encoding: "utf8" });
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return false;
    const startTicks = Number(stat.slice(closeParen + 2).split(" ")[19]);
    if (!Number.isFinite(startTicks)) return false;
    const btime = /(?:^|\n)btime (\d+)/.exec(readFileSync("/proc/stat", { encoding: "utf8" }));
    if (btime === null) return false;
    const startMs = Number(btime[1]) * 1000 + (startTicks * 1000) / 100;
    return startMs > acquiredAt + 1000;
  } catch {
    return false;
  }
}

function lockMtimeMs(lockPath: string): number | null {
  try {
    return statSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
}

function isAbandoned(rec: LockRecord, now: number, lockPath: string): boolean {
  if (rec.pid === null) {
    const mtime = lockMtimeMs(lockPath);
    return mtime !== null && now - mtime > STALE_LOCK_HARD_CAP_MS;
  }
  if (!processExists(rec.pid)) return true;
  if (rec.acquiredAt !== null && linuxPidStartedAfter(rec.pid, rec.acquiredAt)) return true;
  if (rec.acquiredAt !== null && now - rec.acquiredAt > STALE_LOCK_HARD_CAP_MS) return true;
  return false;
}

function recordsMatch(a: LockRecord, b: LockRecord): boolean {
  return a.pid === b.pid && a.token === b.token && a.acquiredAt === b.acquiredAt;
}

/** Atomic rename reclaim: one waiter wins; losers see ENOENT. */
function tryReclaimAbandonedOwner(
  lockPath: string,
  now: number,
  containmentRoot?: string,
): boolean {
  const observed = parseLockRecord(lockPath);
  if (!isAbandoned(observed, now, lockPath)) return false;
  const quarantine = `${lockPath}.reclaim.${process.pid}.${randomUUID()}`;
  if (containmentRoot !== undefined) {
    assertWriteTargetSafe(containmentRoot, lockPath);
    assertWriteTargetSafe(containmentRoot, quarantine);
  }
  try {
    renameSync(lockPath, quarantine);
  } catch {
    return false;
  }
  const quarantined = parseLockRecord(quarantine);
  if (recordsMatch(observed, quarantined)) {
    try {
      unlinkSync(quarantine);
    } catch {
      /* already gone */
    }
    return true;
  }
  try {
    renameSync(quarantine, lockPath);
  } catch {
    /* best-effort restore */
  }
  return false;
}

/** Serialise appenders across threads AND processes (sidecar lock file). */
export function withAppendLock<T>(
  logPath: string,
  fn: (held: HeldLock) => T,
  deps: LockDeps = {},
): T {
  const sleepMs = deps.sleepMs ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const budgetMs = deps.acquisitionBudgetMs ?? DEFAULT_ACQUISITION_BUDGET_MS;
  const lockPath = `${logPath}.lock`;
  if (deps.containmentRoot !== undefined) {
    assertWriteTargetSafe(deps.containmentRoot, lockPath);
  }
  mkdirSync(dirname(lockPath), { recursive: true });

  if (threadLocked.held) {
    throw new Error("append lock is not reentrant");
  }
  threadLocked.held = true;
  let fd: number | undefined;
  let held: HeldLock | undefined;
  try {
    const deadline = now() + budgetMs;
    while (true) {
      try {
        fd = openSync(lockPath, "wx");
        const token = randomUUID();
        const acquiredAt = now();
        writeSync(fd, Buffer.from(`${process.pid}\n${token}\n${acquiredAt}\n`));
        held = { lockPath, pid: process.pid, token, acquiredAt };
        return fn(held);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          throw err;
        }
        // Reclaim a dead holder before sleeping so a crashed writer cannot
        // burn the caller's acquisition budget (#3872 / occupancy AC4).
        if (tryReclaimAbandonedOwner(lockPath, now(), deps.containmentRoot)) {
          continue;
        }
        if (now() > deadline) {
          throw new Error(`timed out acquiring lock for ${logPath}`);
        }
        sleepMs(20);
      }
    }
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
    if (held !== undefined) {
      try {
        assertAppendLockOwned(held);
        if (existsSync(lockPath)) {
          unlinkSync(lockPath);
        }
      } catch {
        /* not ours anymore */
      }
    }
    threadLocked.held = false;
  }
}

/** Public alias mirroring Python append_lock. */
export const appendLock = withAppendLock;
