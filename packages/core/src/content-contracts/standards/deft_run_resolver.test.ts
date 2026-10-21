/**
 * Behavioural coverage for .githooks/_directive-run.sh / run_directive (#5802).
 *
 * OVPR helper always dispatches via node_modules/@deftai/directive-runtime/dist/bin.js
 * (plus .deft-directive-disable kill-switch). Legacy local-CLI preference (#2248)
 * lived on _deft-run.sh and is retired with the tip cutover.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./_helpers.js";

const HOOK_SCRIPT = join(repoRoot(), ".githooks", "_directive-run.sh");
const NODE_DIR = dirname(process.execPath);
const isWindows = process.platform === "win32";

function bashPath(): string {
  for (const candidate of ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "bash";
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function fakeRepoWithRuntimeBin(): string {
  const root = tempDir("directive-run-repo-");
  const distDir = join(root, "node_modules", "@deftai", "directive-runtime", "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    join(distDir, "bin.js"),
    'console.log("RUNTIME " + process.argv.slice(2).join(" "));\n',
  );
  return root;
}

function runResolver(env: { repoRoot: string; pathDirs: string[] }): string {
  const script = `set -eu\n. ${JSON.stringify(HOOK_SCRIPT)}\nrun_directive hello world\n`;
  return execFileSync(bashPath(), ["-c", script], {
    env: {
      REPO_ROOT: env.repoRoot,
      PATH: env.pathDirs.join(":"),
    },
    encoding: "utf8",
  }).trim();
}

describe("_directive-run.sh run_directive resolution (#5802)", () => {
  it.skipIf(isWindows)("dispatches via installed runtime bin.js", () => {
    const repo = fakeRepoWithRuntimeBin();
    const out = runResolver({ repoRoot: repo, pathDirs: [NODE_DIR] });
    expect(out).toBe("RUNTIME hello world");
  });

  it.skipIf(isWindows)("errors when runtime bin is missing", () => {
    const repo = tempDir("directive-run-empty-");
    expect(() => runResolver({ repoRoot: repo, pathDirs: [NODE_DIR] })).toThrow();
  });

  it.skipIf(isWindows)("kill-switch skips CLI spawn for untracked .deft-directive-disable", () => {
    const repo = fakeRepoWithRuntimeBin();
    writeFileSync(join(repo, ".deft-directive-disable"), "1\n");
    // init git so ls-files works; leave flag untracked
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const out = runResolver({ repoRoot: repo, pathDirs: [NODE_DIR] });
    expect(out).toBe("");
  });
});
