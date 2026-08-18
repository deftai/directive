import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

const threadLocked = { held: false };

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

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Linux-only: process start after lock acquire means this PID reused the slot. */
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

/** Unlink only an abandoned lock: dead PID, or Linux PID reuse. Never age-reclaim a live holder. */
function tryReclaimAbandonedOwner(lockPath: string): boolean {
  const { pid, acquiredAt } = parseLockRecord(lockPath);
  if (pid === null) return false;
  const abandoned =
    !processExists(pid) || (acquiredAt !== null && linuxPidStartedAfter(pid, acquiredAt));
  if (!abandoned) return false;
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
          if (!reclaimedStale && tryReclaimAbandonedOwner(lockPath)) {
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
