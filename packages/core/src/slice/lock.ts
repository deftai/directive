import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

const threadLocked = { held: false };

/** 10× occupancy heartbeat TTL. Off-Linux PID reuse / stalled holder reclaim. */
export const STALE_LOCK_HARD_CAP_MS = 20 * 60 * 1000 * 10;

export interface LockDeps {
  readonly sleepMs?: (ms: number) => void;
  readonly now?: () => number;
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
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin */
  }
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

function isAbandoned(rec: LockRecord, now: number): boolean {
  if (rec.pid === null) return false;
  if (!processExists(rec.pid)) return true;
  if (rec.acquiredAt !== null && linuxPidStartedAfter(rec.pid, rec.acquiredAt)) return true;
  if (rec.acquiredAt !== null && now - rec.acquiredAt > STALE_LOCK_HARD_CAP_MS) return true;
  return false;
}

function recordsMatch(a: LockRecord, b: LockRecord): boolean {
  return a.pid === b.pid && a.token === b.token && a.acquiredAt === b.acquiredAt;
}

/** Atomic rename reclaim: one waiter wins; losers see ENOENT. */
function tryReclaimAbandonedOwner(lockPath: string, now: number): boolean {
  const observed = parseLockRecord(lockPath);
  if (!isAbandoned(observed, now)) return false;
  const quarantine = `${lockPath}.reclaim.${process.pid}.${randomUUID()}`;
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
  const lockPath = `${logPath}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });

  if (threadLocked.held) {
    throw new Error("append lock is not reentrant");
  }
  threadLocked.held = true;
  let fd: number | undefined;
  let held: HeldLock | undefined;
  let reclaimedStale = false;
  try {
    const deadline = now() + 30_000;
    while (true) {
      try {
        fd = openSync(lockPath, "wx");
        const token = randomUUID();
        const acquiredAt = now();
        writeSync(fd, Buffer.from(`${process.pid}\n${token}\n${acquiredAt}\n`));
        held = { lockPath, pid: process.pid, token, acquiredAt };
        break;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          throw err;
        }
        if (now() > deadline) {
          if (!reclaimedStale && tryReclaimAbandonedOwner(lockPath, now())) {
            reclaimedStale = true;
            continue;
          }
          throw new Error(`timed out acquiring lock for ${logPath}`);
        }
        sleepMs(20);
      }
    }
    if (held === undefined) {
      throw new Error(`timed out acquiring lock for ${logPath}`);
    }
    return fn(held);
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
