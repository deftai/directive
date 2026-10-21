import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluate, stripShellCommentLines } from "./verify-hooks-installed.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

const temps: string[] = [];
afterEach(() => {
  for (const temp of temps) {
    rmSync(temp, { recursive: true, force: true });
  }
  temps.length = 0;
});

const DEFT_PRE_COMMIT = `#!/usr/bin/env sh
run_directive verify:encoding --staged --project-root "$REPO_ROOT"
`;

const DEFT_PRE_PUSH = `#!/usr/bin/env sh
run_directive verify:branch --project-root "$REPO_ROOT"
`;

const LEGACY_PYTHON_PRE_COMMIT = `#!/usr/bin/env sh
python3 scripts/preflight_branch.py --project-root "$REPO_ROOT"
`;

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-hooks-"));
  temps.push(root);
  return root;
}

function makeDeftHooks(root: string, rel = ".githooks"): string {
  const hooks = join(root, rel);
  mkdirSync(hooks, { recursive: true });
  const preCommit = join(hooks, "pre-commit");
  const prePush = join(hooks, "pre-push");
  writeFileSync(preCommit, DEFT_PRE_COMMIT, "utf8");
  writeFileSync(prePush, DEFT_PRE_PUSH, "utf8");
  writeFileSync(join(hooks, "_directive-run.sh"), 'run_directive() { deft "$@"; }\n', "utf8");
  chmodSync(preCommit, 0o755);
  chmodSync(prePush, 0o755);
  return hooks;
}

describe("evaluate", () => {
  it("passes for functional deft-cli hooks without scripts/", () => {
    const root = makeRepo();
    makeDeftHooks(root);
    const result = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: ".githooks", error: null }),
    });
    expect(result.code).toBe(0);
    expect(result.message).toContain("dispatch via deft CLI");
  });

  it("returns config error for missing project root", () => {
    const root = makeRepo();
    const result = evaluate(join(root, "missing"), {
      gitConfigReader: () => ({ hooksPath: null, error: null }),
    });
    expect(result.code).toBe(2);
    expect(result.message).toContain("does not exist");
  });

  it("returns not installed when hooks path unset", () => {
    const root = makeRepo();
    const result = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: null, error: null }),
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("not installed");
  });

  it("returns config error when git unavailable", () => {
    const root = makeRepo();
    const result = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: null, error: "git executable not found on PATH" }),
    });
    expect(result.code).toBe(2);
    expect(result.message).toContain("cannot read core.hooksPath");
  });

  it("fails when hooks still dispatch through Python (#2049)", () => {
    const root = makeRepo();
    const hooks = join(root, ".githooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-commit"), LEGACY_PYTHON_PRE_COMMIT, "utf8");
    writeFileSync(join(hooks, "pre-push"), DEFT_PRE_PUSH, "utf8");
    chmodSync(join(hooks, "pre-commit"), 0o755);
    chmodSync(join(hooks, "pre-push"), 0o755);
    const result = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: ".githooks", error: null }),
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("Python scripts");
  });

  it("fails when pre-commit omits required deft gates", () => {
    const root = makeRepo();
    const hooks = join(root, ".githooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-commit"), "echo noop\n", "utf8");
    writeFileSync(join(hooks, "pre-push"), DEFT_PRE_PUSH, "utf8");
    writeFileSync(join(hooks, "_directive-run.sh"), "run_directive() { :; }\n", "utf8");
    chmodSync(join(hooks, "pre-commit"), 0o755);
    chmodSync(join(hooks, "pre-push"), 0o755);
    const result = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: ".githooks", error: null }),
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("verify:encoding");
  });

  it("fails when pre-push omits verify:branch", () => {
    const root = makeRepo();
    const hooks = join(root, ".githooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-commit"), DEFT_PRE_COMMIT, "utf8");
    writeFileSync(join(hooks, "pre-push"), "echo noop\n", "utf8");
    writeFileSync(join(hooks, "_directive-run.sh"), "run_directive() { :; }\n", "utf8");
    chmodSync(join(hooks, "pre-commit"), 0o755);
    chmodSync(join(hooks, "pre-push"), 0o755);
    const result = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: ".githooks", error: null }),
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("verify:branch");
  });

  it("fails when hooks wired but directory missing", () => {
    const root = makeRepo();
    const result = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: ".githooks", error: null }),
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("does not exist");
  });

  it("fails when posix hooks are not executable", () => {
    const root = makeRepo();
    const hooks = join(root, ".githooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-commit"), DEFT_PRE_COMMIT, "utf8");
    writeFileSync(join(hooks, "pre-push"), DEFT_PRE_PUSH, "utf8");
    writeFileSync(join(hooks, "_directive-run.sh"), 'run_directive() { deft "$@"; }\n', "utf8");
    chmodSync(join(hooks, "pre-commit"), 0o644);
    chmodSync(join(hooks, "pre-push"), 0o644);
    const result = evaluate(root, {
      platform: "linux",
      hookExecutable: () => false,
      gitConfigReader: () => ({ hooksPath: ".githooks", error: null }),
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("not executable");
  });

  it("fails when hook body lacks deft CLI dispatch", () => {
    const root = makeRepo();
    const hooks = join(root, ".githooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-commit"), "echo noop\n", "utf8");
    writeFileSync(join(hooks, "pre-push"), DEFT_PRE_PUSH, "utf8");
    writeFileSync(join(hooks, "_directive-run.sh"), "run_directive() { :; }\n", "utf8");
    chmodSync(join(hooks, "pre-commit"), 0o755);
    chmodSync(join(hooks, "pre-push"), 0o755);
    const result = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: ".githooks", error: null }),
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("verify:encoding");
  });

  it("fails when hook references legacy SCRIPTS_DIR dispatch", () => {
    const root = makeRepo();
    const hooks = join(root, ".githooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(
      join(hooks, "pre-commit"),
      "SCRIPTS_DIR=foo\ndeft verify:branch\ndeft verify:encoding\n",
      "utf8",
    );
    writeFileSync(join(hooks, "pre-push"), DEFT_PRE_PUSH, "utf8");
    chmodSync(join(hooks, "pre-commit"), 0o755);
    chmodSync(join(hooks, "pre-push"), 0o755);
    const result = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: ".githooks", error: null }),
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("Python scripts");
  });

  it("passes with absolute hooks path", () => {
    const root = makeRepo();
    const hooks = makeDeftHooks(root, "custom-hooks");
    const result = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: hooks, error: null }),
    });
    expect(result.code).toBe(0);
  });

  it("fails when pre-commit hook file is missing (directory placeholder)", () => {
    const root = makeRepo();
    const hooks = join(root, ".githooks");
    mkdirSync(hooks, { recursive: true });
    mkdirSync(join(hooks, "pre-commit"));
    writeFileSync(join(hooks, "pre-push"), DEFT_PRE_PUSH, "utf8");
    chmodSync(join(hooks, "pre-push"), 0o755);
    const result = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: ".githooks", error: null }),
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("missing pre-commit");
  });

  it("fails when hook references preflight_branch.py shim", () => {
    const root = makeRepo();
    const hooks = join(root, ".githooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(
      join(hooks, "pre-commit"),
      "deft verify:branch\ndeft verify:encoding\npreflight_branch.py\n",
      "utf8",
    );
    writeFileSync(join(hooks, "pre-push"), DEFT_PRE_PUSH, "utf8");
    chmodSync(join(hooks, "pre-commit"), 0o755);
    chmodSync(join(hooks, "pre-push"), 0o755);
    const result = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: ".githooks", error: null }),
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("Python scripts");
  });

  it("allows pre-push verify:branch under OVPR tip hooks (#5802 / retires #1814 ban)", () => {
    const root = makeRepo();
    makeDeftHooks(root);
    const result = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: ".githooks", error: null }),
    });
    expect(result.code).toBe(0);
  });

  it("fails when the shared hook helper is missing", () => {
    const root = makeRepo();
    const hooks = join(root, ".githooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-commit"), DEFT_PRE_COMMIT, "utf8");
    writeFileSync(join(hooks, "pre-push"), DEFT_PRE_PUSH, "utf8");
    chmodSync(join(hooks, "pre-commit"), 0o755);
    chmodSync(join(hooks, "pre-push"), 0o755);
    const result = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: ".githooks", error: null }),
      platform: "linux",
      hookExecutable: () => true,
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("_directive-run.sh");
  });

  it("reports a missing shared hook helper before stale hook content", () => {
    const root = makeRepo();
    const hooks = join(root, ".githooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-commit"), LEGACY_PYTHON_PRE_COMMIT, "utf8");
    writeFileSync(join(hooks, "pre-push"), DEFT_PRE_PUSH, "utf8");
    const result = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: ".githooks", error: null }),
      platform: "linux",
      hookExecutable: () => true,
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("_directive-run.sh");
    expect(result.message).toContain("Python scripts");
  });

  it("greenfield smoke: passes with no scripts/ on PATH (Python-free deposit)", () => {
    const root = makeRepo();
    makeDeftHooks(root);
    let scriptsPresent = false;
    try {
      scriptsPresent = statSync(join(root, "scripts")).isDirectory();
    } catch {
      scriptsPresent = false;
    }
    expect(scriptsPresent).toBe(false);
    const result = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: ".githooks", error: null }),
    });
    expect(result.code).toBe(0);
  });

  it("passes for canonical shipped hook comment headers (#2049 false-positive regression)", () => {
    const root = makeRepo();
    const hooks = join(root, ".githooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(
      join(hooks, "pre-commit"),
      readFileSync(join(REPO_ROOT, ".githooks/pre-commit"), "utf8"),
      "utf8",
    );
    writeFileSync(
      join(hooks, "pre-push"),
      readFileSync(join(REPO_ROOT, ".githooks/pre-push"), "utf8"),
      "utf8",
    );
    writeFileSync(
      join(hooks, "_directive-run.sh"),
      readFileSync(join(REPO_ROOT, ".githooks/_directive-run.sh"), "utf8"),
      "utf8",
    );
    chmodSync(join(hooks, "pre-commit"), 0o755);
    chmodSync(join(hooks, "pre-push"), 0o755);
    const result = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: ".githooks", error: null }),
    });
    expect(result.code).toBe(0);
  });

  it("stripShellCommentLines ignores comment-only trigger words", () => {
    const body = stripShellCommentLines(`# no Python here
# Pre-push does NOT invoke verify:branch
deft verify:branch --project-root "$REPO_ROOT"
`);
    expect(body).toContain("deft verify:branch");
    expect(body).not.toContain("no Python");
  });
});
