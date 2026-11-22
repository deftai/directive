/**
 * #7029: an absolute core.hooksPath in the shared Git config made every linked
 * worktree run one checkout's hooks. Setup rewrites a value that names a
 * checkout's `.githooks` to the relative `.githooks`, so each worktree runs its
 * own tracked hooks; doctor warns on an absolute path outside the worktree.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctorDiagnosisJson, formatDoctorReport, runDoctorDiagnosis } from "./doctor-diagnose.js";
import {
  ensureGitHooks,
  formatHooksPathMadeRelative,
  isCheckoutHooksPathValue,
  readHooksPathState,
} from "./setup-wiring.js";

const TEMPS: string[] = [];
const SAVED: Record<string, string | undefined> = {};

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TEMPS.push(dir);
  return dir;
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeHook(root: string, rel: string, body: string): void {
  const abs = join(root, rel);
  writeFileSync(abs, body);
  chmodSync(abs, 0o755);
}

/** A hook that sources a helper from the checkout it runs in, as Directive's hooks do. */
function preCommitSourcing(helper: string): string {
  return `#!/bin/sh\nREPO_ROOT="$(git rev-parse --show-toplevel)"\n. "$REPO_ROOT/.githooks/${helper}"\n`;
}

function helperWriting(tag: string): string {
  return `printf '${tag}' > "$W7029_MARKER"\n`;
}

function repo(): string {
  const root = temp("w7029-primary-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  git(root, "config", "user.name", "t");
  git(root, "config", "user.email", "t@example.test");
  git(root, "config", "commit.gpgsign", "false");
  return root;
}

/**
 * Primary checkout on an old commit whose hook sources `_old-helper.sh`; a
 * linked worktree on a newer commit where the helper was renamed (the #5802
 * shape). core.hooksPath is the absolute path to the primary's `.githooks`.
 */
function primaryBehindWorktree(): { primary: string; wt: string } {
  const primary = repo();
  mkdirSync(join(primary, ".githooks"));
  writeHook(primary, ".githooks/pre-commit", preCommitSourcing("_old-helper.sh"));
  writeHook(primary, ".githooks/_old-helper.sh", helperWriting("old"));
  git(primary, "add", "--chmod=+x", ".githooks");
  git(primary, "commit", "-q", "--no-verify", "-m", "old hooks");
  git(primary, "checkout", "-q", "-b", "next");
  writeHook(primary, ".githooks/pre-commit", preCommitSourcing("_new-helper.sh"));
  writeHook(primary, ".githooks/_new-helper.sh", helperWriting("new"));
  git(primary, "rm", "-q", ".githooks/_old-helper.sh");
  git(primary, "add", "--chmod=+x", ".githooks");
  git(primary, "commit", "-q", "--no-verify", "-m", "renamed helper");
  git(primary, "checkout", "-q", "main");
  const wt = join(temp("w7029-wt-"), "wt");
  git(primary, "worktree", "add", "-q", wt, "next");
  git(primary, "config", "core.hooksPath", join(primary, ".githooks"));
  return { primary, wt };
}

/** Run a commit in `root`; returns the marker the hook wrote, or throws. */
function commitAndReadMarker(root: string): string {
  const marker = join(temp("w7029-marker-"), "marker");
  execFileSync("git", ["-C", root, "commit", "-q", "--allow-empty", "-m", "probe"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, W7029_MARKER: marker },
  });
  return readFileSync(marker, "utf8");
}

beforeEach(() => {
  for (const k of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) SAVED[k] = process.env[k];
  const globalConfig = join(temp("w7029-global-"), "gitconfig");
  writeFileSync(globalConfig, "");
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe("absolute core.hooksPath across linked worktrees (#7029)", () => {
  it("a linked worktree on a newer commit runs its own .githooks after setup", () => {
    const { primary, wt } = primaryBehindWorktree();
    // The bug: the worktree runs the primary's old hook, whose helper it lacks.
    expect(() => commitAndReadMarker(wt)).toThrow();

    const state = readHooksPathState(wt);
    expect(state.kind).toBe("ours");
    expect(state.needsRelative).toBe(true);
    expect(isCheckoutHooksPathValue(wt, join(primary, ".githooks"))).toBe(true);

    const result = ensureGitHooks(wt);
    expect(result.hooksPathActive).toBe(true);
    expect(result.hooksPathTakenOver).toBeNull();
    expect(result.updated).toContain(formatHooksPathMadeRelative(join(primary, ".githooks")));
    expect(git(wt, "config", "--get", "core.hooksPath")).toBe(".githooks");

    // Each checkout now runs its own tracked hooks and helpers.
    expect(commitAndReadMarker(wt)).toBe("new");
    expect(commitAndReadMarker(primary)).toBe("old");
  });

  it("setup in the primary checkout also rewrites its own absolute path to .githooks", () => {
    const root = repo();
    git(root, "config", "core.hooksPath", join(root, ".githooks"));
    expect(readHooksPathState(root)).toMatchObject({ kind: "ours", needsRelative: true });
    const result = ensureGitHooks(root);
    expect(result.hooksPathActive).toBe(true);
    expect(git(root, "config", "--get", "core.hooksPath")).toBe(".githooks");
    expect(readHooksPathState(root)).toEqual({ kind: "ours", value: ".githooks", scope: "local" });
  });

  it("another tool's absolute hooks folder is still left alone without approval", () => {
    const root = repo();
    const other = join(temp("w7029-other-"), "hooks");
    git(root, "config", "core.hooksPath", other);
    expect(readHooksPathState(root).kind).toBe("foreign");
    const result = ensureGitHooks(root);
    expect(result.hooksPathActive).toBe(false);
    expect(git(root, "config", "--get", "core.hooksPath")).toBe(other);
  });
});

describe("doctor: absolute core.hooksPath outside the worktree (#7029)", () => {
  function diagnose(root: string) {
    return runDoctorDiagnosis(root, { probeHooks: false, findHiddenFiles: () => [] });
  }

  it("warns, exit-exempt, in the report and the --json warnings", () => {
    const { primary, wt } = primaryBehindWorktree();
    const diag = diagnose(wt);
    expect(diag.hooksPathWarning).toContain(join(primary, ".githooks"));
    expect(diag.hooksPathWarning).toContain("directive install --repair");
    expect(formatDoctorReport(diag)).toContain(`warning: ${diag.hooksPathWarning}`);
    expect(doctorDiagnosisJson(diag).warnings).toContain(diag.hooksPathWarning);
  });

  it("warns on another tool's absolute folder outside the worktree", () => {
    const root = repo();
    git(root, "config", "core.hooksPath", join(temp("w7029-other-"), "hooks"));
    expect(diagnose(root).hooksPathWarning).not.toBeNull();
  });

  it("does not warn on the relative value, an absolute path inside the worktree, or unset", () => {
    const root = repo();
    expect(diagnose(root).hooksPathWarning).toBeNull();
    git(root, "config", "core.hooksPath", ".githooks");
    expect(diagnose(root).hooksPathWarning).toBeNull();
    git(root, "config", "core.hooksPath", join(root, ".githooks"));
    expect(diagnose(root).hooksPathWarning).toBeNull();
  });
});
