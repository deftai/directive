/**
 * deft_run_resolver.test.ts -- behavioural coverage for .githooks/_deft-run.sh
 * run_deft resolution (#2248).
 *
 * In a framework-source (monorepo) checkout the freshly-built LOCAL CLI
 * (packages/cli/dist/bin.js) must be preferred over a possibly-stale global
 * `deft`, otherwise a newly-added-and-wired verb is unknown to the global and
 * blocks every commit. Consumer installs (no local build) must keep resolving
 * the global. A DEFT_HOOKS_PREFER_GLOBAL=1 escape hatch forces the global.
 *
 * These tests source the REAL hook resolver under a temp $REPO_ROOT and a fake
 * `deft` on PATH, then assert which CLI run_deft dispatches to.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./_helpers.js";

const HOOK_SCRIPT = join(repoRoot(), ".githooks", "_deft-run.sh");
const NODE_DIR = dirname(process.execPath);
const isWindows = process.platform === "win32";

/**
 * Absolute path to bash. The child's PATH is deliberately restricted (so a
 * globally-installed `deft` cannot leak in), which means the bash executable
 * itself must be resolved by absolute path rather than PATH lookup.
 */
function bashPath(): string {
  for (const candidate of ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return "bash";
}

/** A fresh temp dir under the OS temp root. */
function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Deposit a fake global `deft` on a temp bin dir that echoes a GLOBAL marker. */
function fakeGlobalBin(): string {
  const dir = tempDir("deft-run-global-");
  const deft = join(dir, "deft");
  writeFileSync(deft, '#!/bin/sh\necho "GLOBAL $*"\n');
  chmodSync(deft, 0o755);
  return dir;
}

/** Build a temp REPO_ROOT, optionally with a built local CLI + monorepo sentinel. */
function fakeRepoRoot(opts: { withDist: boolean; withSentinel: boolean }): string {
  const root = tempDir("deft-run-repo-");
  if (opts.withDist) {
    const distDir = join(root, "packages", "cli", "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(
      join(distDir, "bin.js"),
      'console.log("LOCAL " + process.argv.slice(2).join(" "));\n',
    );
  }
  if (opts.withSentinel) {
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  }
  return root;
}

/** Source the real resolver under a controlled env and return run_deft stdout. */
function runResolver(env: {
  repoRoot: string;
  pathDirs: string[];
  preferGlobal?: boolean;
}): string {
  const script = `set -eu\n. ${JSON.stringify(HOOK_SCRIPT)}\nrun_deft hello world\n`;
  const childEnv: NodeJS.ProcessEnv = {
    REPO_ROOT: env.repoRoot,
    PATH: env.pathDirs.join(":"),
  };
  if (env.preferGlobal) {
    childEnv.DEFT_HOOKS_PREFER_GLOBAL = "1";
  }
  return execFileSync(bashPath(), ["-c", script], {
    env: childEnv,
    encoding: "utf8",
  }).trim();
}

describe("_deft-run.sh run_deft resolution (#2248)", () => {
  it.skipIf(isWindows)("prefers the LOCAL built CLI in a framework-source checkout", () => {
    const repo = fakeRepoRoot({ withDist: true, withSentinel: true });
    const globalDir = fakeGlobalBin();
    const out = runResolver({ repoRoot: repo, pathDirs: [globalDir, NODE_DIR] });
    expect(out).toBe("LOCAL hello world");
  });

  it.skipIf(isWindows)("prefers the global `deft` when there is no local build", () => {
    const repo = fakeRepoRoot({ withDist: false, withSentinel: true });
    const globalDir = fakeGlobalBin();
    const out = runResolver({ repoRoot: repo, pathDirs: [globalDir, NODE_DIR] });
    expect(out).toBe("GLOBAL hello world");
  });

  it.skipIf(isWindows)(
    "DEFT_HOOKS_PREFER_GLOBAL=1 forces the global even with a local build",
    () => {
      const repo = fakeRepoRoot({ withDist: true, withSentinel: true });
      const globalDir = fakeGlobalBin();
      const out = runResolver({
        repoRoot: repo,
        pathDirs: [globalDir, NODE_DIR],
        preferGlobal: true,
      });
      expect(out).toBe("GLOBAL hello world");
    },
  );

  it.skipIf(isWindows)("errors (exit 1) when neither a global nor a local build resolves", () => {
    const repo = fakeRepoRoot({ withDist: false, withSentinel: false });
    // PATH deliberately excludes NODE_DIR so a globally-installed `deft` living
    // beside `node` cannot leak in; the error path needs no external binary.
    const emptyDir = tempDir("deft-run-empty-");
    expect(() => runResolver({ repoRoot: repo, pathDirs: [emptyDir] })).toThrow();
  });
});
