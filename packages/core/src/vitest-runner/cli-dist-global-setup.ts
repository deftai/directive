import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const LOCK_STALE_MS = 120_000;

interface LockMeta {
  readonly pid: number;
  readonly startedAt: number;
}

function sleepMs(ms: number): void {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // Busy-wait for short lock spins in test coordination only.
  }
}

function repoRoot(): string {
  return resolve(import.meta.dirname, "../../../..");
}

function lockMetaPath(root: string): string {
  return resolve(root, ".deft-scratch/vitest-cli-dist-build.lock.json");
}

function readLockMeta(root: string): LockMeta | null {
  const metaPath = lockMetaPath(root);
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, "utf8")) as LockMeta;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isStaleVitestCliDistLock(root: string, now = Date.now()): boolean {
  const meta = readLockMeta(root);
  if (!meta) return true;
  if (isProcessAlive(meta.pid)) return false;
  return now - meta.startedAt > LOCK_STALE_MS;
}

export function acquireVitestCliDistBuildLock(root: string, timeoutMs = 60_000): void {
  mkdirSync(resolve(root, ".deft-scratch"), { recursive: true });
  const metaPath = lockMetaPath(root);
  const payload = JSON.stringify({ pid: process.pid, startedAt: Date.now() } satisfies LockMeta);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(metaPath)) {
      if (!isStaleVitestCliDistLock(root)) {
        sleepMs(50);
        continue;
      }
      rmSync(metaPath, { force: true });
    }
    try {
      const fd = openSync(metaPath, "wx");
      try {
        writeFileSync(fd, payload);
      } finally {
        closeSync(fd);
      }
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        sleepMs(50);
        continue;
      }
      throw err;
    }
  }
  throw new Error("timed out acquiring vitest CLI dist build lock");
}

export function releaseVitestCliDistBuildLock(root: string): void {
  rmSync(lockMetaPath(root), { force: true });
}

/**
 * Build packages/cli dist once before Vitest forks workers so dist-backed subprocess
 * regressions (#2846) never race parallel readers or mid-suite tsc -b writes.
 * Incremental `tsc -b` is a no-op when `task check` already built.
 */
export default function setup(): () => void {
  const root = repoRoot();
  acquireVitestCliDistBuildLock(root);
  try {
    const tscBin = resolve(root, "node_modules/typescript/bin/tsc");
    execFileSync(process.execPath, [tscBin, "-b", "packages/cli"], {
      cwd: root,
      stdio: "pipe",
    });
  } catch (err) {
    releaseVitestCliDistBuildLock(root);
    throw err;
  }
  return () => releaseVitestCliDistBuildLock(root);
}
