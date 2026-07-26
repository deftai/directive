import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Build packages/cli dist once before Vitest forks workers so dist-backed subprocess
 * regressions (#2846) never race parallel readers or mid-suite tsc -b writes.
 * Incremental `tsc -b` is a no-op when `task check` already built.
 */
export default function setup(): void {
  const repoRoot = resolve(import.meta.dirname, "../../../..");
  const tscBin = resolve(repoRoot, "node_modules/typescript/bin/tsc");
  execFileSync(process.execPath, [tscBin, "-b", "packages/cli"], {
    cwd: repoRoot,
    stdio: "pipe",
  });
}
