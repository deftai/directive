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

function lockOwnerPid(lockPath: string): number | null {
  try {
    const text = readFileSync(lockPath, { encoding: "utf8" }).trim();
    if (!/^\d+$/.test(text)) return null;
    const pid = Number(text);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
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

/** Unlink only when the lock file names a PID that is proven dead. */
function tryReclaimDeadOwner(lockPath: string): boolean {
  const pid = lockOwnerPid(lockPath);
  if (pid === null || processExists(pid)) return false;
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
        writeSync(fd, Buffer.from(`${process.pid}\n`));
        break;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          throw err;
        }
        if (now() > deadline) {
          if (!reclaimedStale && tryReclaimDeadOwner(lockPath)) {
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
