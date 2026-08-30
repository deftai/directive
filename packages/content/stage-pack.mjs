/**
 * prepack entry for @deftai/directive-content (#3937).
 * Prefers compiled dist; falls back to root-workspace tsx so `npm pack` works
 * after `pnpm install` at the repo root without requiring a prior tsc.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const distRunner = join(repoRoot, "packages", "core", "dist", "deposit", "run-stage-content-pack.js");
const tsRunner = join(repoRoot, "packages", "core", "src", "deposit", "run-stage-content-pack.ts");
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

function run(argv) {
  const result = spawnSync(process.execPath, argv, { cwd: here, stdio: "inherit" });
  process.exit(result.status === null ? 1 : result.status);
}

if (existsSync(distRunner)) {
  run([distRunner]);
} else if (existsSync(tsxCli) && existsSync(tsRunner)) {
  run([tsxCli, tsRunner]);
} else {
  process.stderr.write(
    "stage-pack: need packages/core dist (task build) or repo-root tsx to rewrite deposit links\n",
  );
  process.exit(2);
}
