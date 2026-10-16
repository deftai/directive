import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENFORCE_NOOP_NOTICE, parseArgs, run } from "./verify-scope-provenance.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");

function git(root: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "scope-prov-cli-"));
  git(root, ["init", "-q"]);
  git(root, ["checkout", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "test"]);
  return root;
}

function writeTracked(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body, "utf8");
  git(root, ["add", "--", rel]);
}

function commit(root: string, msg: string): void {
  git(root, ["commit", "-q", "-m", msg, "--allow-empty"]);
}

function xbrief(title: string, fileScope: readonly string[]): string {
  return `${JSON.stringify(
    {
      xBRIEFInfo: { version: "0.8" },
      plan: {
        id: "story-1",
        status: "running",
        title,
        metadata: { swarm: { file_scope: [...fileScope] } },
      },
    },
    null,
    2,
  )}\n`;
}

function captureRun(argv: string[]): { code: number; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
    stdout += String(c);
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((c) => {
    stderr += String(c);
    return true;
  });
  try {
    return { code: run(argv), stdout, stderr };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

describe("verify-scope-provenance CLI (#3145 / #5057)", () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length > 0) {
      const root = roots.pop();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it("parses base-ref and enforce", () => {
    const a = parseArgs(["--project-root=.", "--base-ref", "HEAD", "--enforce"]);
    expect(a.error).toBeUndefined();
    expect(a.baseRef).toBe("HEAD");
    expect(a.enforce).toBe(true);
    expect(a.enforcePresent).toBe(true);
  });

  it("keeps --enforce parsed; later --warn wins the boolean (#5057)", () => {
    const a = parseArgs(["--enforce", "--warn"]);
    expect(a.error).toBeUndefined();
    expect(a.enforce).toBe(false);
    expect(a.enforcePresent).toBe(true);
  });

  it("rejects unknown args", () => {
    expect(parseArgs(["--bad"]).error).toMatch(/unrecognized/);
  });

  it("task description no longer teaches fail-closed --enforce or missing digests warn (#5057)", () => {
    const yml = readFileSync(join(repoRoot, "tasks/verify.yml"), "utf8");
    const block = yml.split("\n  scope-provenance:\n")[1]?.split("\n  ")[0] ?? "";
    expect(block).toMatch(/desc:/);
    expect(block).not.toMatch(/pass --enforce to fail closed/i);
    expect(block).not.toMatch(/missing digests warn/i);
    expect(block).toMatch(/does not change the exit code/);
  });

  it("prints the --enforce no-op notice on clean, including --quiet (#5057)", () => {
    const root = initRepo();
    roots.push(root);
    writeTracked(root, "README.md", "seed\n");
    commit(root, "seed");
    git(root, ["branch", "base"]);

    const plain = captureRun(["--project-root", root, "--base-ref", "base", "--enforce"]);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toMatch(/clean/i);
    expect(plain.stderr).toContain(ENFORCE_NOOP_NOTICE);
    expect(plain.stderr).not.toMatch(/pass --enforce to fail closed/);

    const quiet = captureRun([
      "--project-root",
      root,
      "--base-ref",
      "base",
      "--enforce",
      "--quiet",
    ]);
    expect(quiet.code).toBe(0);
    expect(quiet.stdout).toBe("");
    expect(quiet.stderr).toContain(ENFORCE_NOOP_NOTICE);
  });

  it("prints the --enforce no-op notice on WARN with identical exit 0 (#5057)", () => {
    const root = initRepo();
    roots.push(root);
    writeTracked(
      root,
      "xbrief/active/story.xbrief.json",
      xbrief("old", ["packages/core/src/scope-provenance/evaluate.ts"]),
    );
    commit(root, "base brief");
    git(root, ["branch", "base"]);
    git(root, ["checkout", "-q", "-b", "impl"]);
    writeTracked(
      root,
      "xbrief/active/story.xbrief.json",
      xbrief("changed", ["packages/core/src/scope-provenance/evaluate.ts"]),
    );
    commit(root, "title edit");

    const off = captureRun(["--project-root", root, "--base-ref", "base"]);
    const on = captureRun(["--project-root", root, "--base-ref", "base", "--enforce"]);
    expect(off.code).toBe(0);
    expect(on.code).toBe(0);
    expect(off.code).toBe(on.code);
    expect(off.stdout).toMatch(/WARN/i);
    expect(on.stdout).toMatch(/WARN/i);
    expect(off.stdout).not.toMatch(/--enforce/);
    expect(on.stdout).not.toMatch(/--enforce/);
    expect(off.stderr).not.toContain(ENFORCE_NOOP_NOTICE);
    expect(on.stderr).toContain(ENFORCE_NOOP_NOTICE);

    const quiet = captureRun([
      "--project-root",
      root,
      "--base-ref",
      "base",
      "--enforce",
      "--quiet",
    ]);
    expect(quiet.code).toBe(0);
    expect(quiet.stdout).toBe("");
    expect(quiet.stderr).toContain(ENFORCE_NOOP_NOTICE);
  });

  // Windows dest worktrees: one git show per lifecycle brief (~1800) is ~200ms
  // each here (~6 min serial); suite load pushes past the 240s win32 project
  // default. Do not undercut with a tighter per-it timeout (#5391 lane flake).
  it("runs against framework root", { timeout: 900_000 }, () => {
    // Exit 2 is config/network (e.g. PR-aware base resolution) — still a successful CLI smoke.
    const code = run(["--project-root", ".", "--quiet", "--base-ref", "HEAD"]);
    expect([0, 1, 2]).toContain(code);
  });
});
