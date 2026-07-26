import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const BUILD_LOCK_DIR = join(REPO_ROOT, ".deft-scratch/cli-dist-test-build.lock");
const TSC_BIN = join(REPO_ROOT, "node_modules/typescript/bin/tsc");

function sleepMs(ms: number): void {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // Busy-wait for short lock spins in test coordination only.
  }
}

/** Wait until no Vitest worker is mid-build of packages/cli dist outputs. */
export function waitForCliDistBuildIdle(timeoutMs = 30_000): void {
  const deadline = Date.now() + timeoutMs;
  while (existsSync(BUILD_LOCK_DIR)) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for packages/cli dist build lock");
    }
    sleepMs(25);
  }
}

/**
 * Run incremental `tsc -b packages/cli`, serializing concurrent Vitest workers via a
 * repo-scoped lock. Always invokes tsc so stale dist artifacts refresh after source edits.
 */
export function ensureCliDistBuiltWithLock(): void {
  mkdirSync(join(REPO_ROOT, ".deft-scratch"), { recursive: true });
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      mkdirSync(BUILD_LOCK_DIR);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      if (Date.now() >= deadline) {
        throw new Error("timed out acquiring packages/cli dist build lock");
      }
      sleepMs(25);
    }
  }

  try {
    execFileSync(process.execPath, [TSC_BIN, "-b", "packages/cli"], {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });
  } finally {
    rmSync(BUILD_LOCK_DIR, { recursive: true, force: true });
  }
}
