import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LOCK_DIR = join(tmpdir(), "deft-directive-packages-cli-dist-build.lock");
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const TSC_BIN = join(REPO_ROOT, "node_modules/typescript/bin/tsc");

function sleepMs(ms: number): void {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // Busy-wait: test coordination only; avoids adding timers deps to the gate.
  }
}

/** Wait until no Vitest worker is mid-build of packages/cli dist outputs. */
export function waitForCliDistBuildIdle(timeoutMs = 30_000): void {
  const deadline = Date.now() + timeoutMs;
  while (existsSync(LOCK_DIR)) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for packages/cli dist build lock");
    }
    sleepMs(25);
  }
}

/** Build packages/cli dist once, serializing concurrent Vitest workers via a lock. */
export function ensureCliDistBuiltWithLock(): void {
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      mkdirSync(LOCK_DIR);
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
    rmSync(LOCK_DIR, { recursive: true, force: true });
  }
}
