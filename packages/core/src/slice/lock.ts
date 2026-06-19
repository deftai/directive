import { closeSync, existsSync, mkdirSync, openSync, unlinkSync, writeSync } from "node:fs";
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
  try {
    const deadline = now() + 30_000;
    while (true) {
      try {
        fd = openSync(lockPath, "wx");
        writeSync(fd, Buffer.from("\0"));
        break;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          throw err;
        }
        if (now() > deadline) {
          throw new Error(`timed out acquiring lock for ${logPath}`);
        }
        sleepMs(20);
      }
    }
    return fn();
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
    threadLocked.held = false;
    try {
      if (existsSync(lockPath)) {
        unlinkSync(lockPath);
      }
    } catch {
      /* best-effort */
    }
  }
}

/** Public alias mirroring Python append_lock. */
export const appendLock = withAppendLock;
