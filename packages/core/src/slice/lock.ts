import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

const threadLocked = { held: false };

/** Critical sections are milliseconds; a lock older than this is abandoned (covers PID reuse). */
export const STALE_LOCK_MS = 120_000;

export interface LockDeps {
  readonly sleepMs?: (ms: number) => void;
  readonly now?: () => number;
}

function defaultSleep(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin */
  }
}

function parseLockRecord(lockPath: string): { pid: number | null; acquiredAt: number | null } {
  try {
    const lines = readFileSync(lockPath, { encoding: "utf8" }).trim().split(/\r?\n/);
    const pidRaw = Number(lines[0]);
    const acquiredRaw = Number(lines[1]);
    return {
      pid: Number.isInteger(pidRaw) && pidRaw > 0 ? pidRaw : null,
      acquiredAt: Number.isInteger(acquiredRaw) && acquiredRaw > 0 ? acquiredRaw : null,
    };
  } catch {
    return { pid: null, acquiredAt: null };
  }
}

function lockAgeMs(lockPath: string, acquiredAt: number | null, now: number): number | null {
  if (acquiredAt !== null) return Math.max(0, now - acquiredAt);
  try {
    return Math.max(0, now - statSync(lockPath).mtimeMs);
  } catch {
    return null;
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

/** Unlink only a dead-PID lock or a lock older than STALE_LOCK_MS (PID reuse / abandoned). */
function tryReclaimStaleOwner(lockPath: string, now: number): boolean {
  const { pid, acquiredAt } = parseLockRecord(lockPath);
  const age = lockAgeMs(lockPath, acquiredAt, now);
  const pidDead = pid !== null && !processExists(pid);
  const abandoned = age !== null && age > STALE_LOCK_MS;
  if (!pidDead && !abandoned) return false;
  try {
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/** Serialise appenders across threads AND processes (sidecar lock file). */
export function withAppendLock<T>(logPath: string, fn: () => T, deps: LockDeps = {}): T {
  const sleepMs = deps.sleepMs ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const lockPath = `${logPath}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });

  if (threadLocked.held) {
    throw new Error("append lock is not reentrant");
  }
  threadLocked.held = true;
  let fd: number | undefined;
  let reclaimedStale = false;
  try {
    const deadline = now() + 30_000;
    while (true) {
      try {
        fd = openSync(lockPath, "wx");
        writeSync(fd, Buffer.from(`${process.pid}\n${now()}\n`));
        break;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          throw err;
        }
        if (now() > deadline) {
          if (!reclaimedStale && tryReclaimStaleOwner(lockPath, now())) {
            reclaimedStale = true;
            continue;
          }
          throw new Error(`timed out acquiring lock for ${logPath}`);
        }
        sleepMs(20);
      }
    }
    return fn();
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
      try {
        if (existsSync(lockPath)) {
          unlinkSync(lockPath);
        }
      } catch {
        /* best-effort owner cleanup */
      }
    }
    threadLocked.held = false;
  }
}

/** Public alias mirroring Python append_lock. */
export const appendLock = withAppendLock;
