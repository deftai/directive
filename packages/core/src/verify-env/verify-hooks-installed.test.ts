import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluate } from "./verify-hooks-installed.js";

const temps: string[] = [];
afterEach(() => {
  for (const temp of temps) {
    rmSync(temp, { recursive: true, force: true });
  }
  temps.length = 0;
});

const DEFT_PRE_COMMIT = `#!/usr/bin/env sh
deft verify:branch --project-root "$REPO_ROOT"
deft verify:encoding --staged --project-root "$REPO_ROOT"
deft verify:vbrief-conformance --staged --project-root "$REPO_ROOT"
`;

const DEFT_PRE_PUSH = `#!/usr/bin/env sh
deft preflight-gh --pre-push-stdin
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
    writeFileSync(join(hooks, "pre-commit"), "deft verify:encoding --staged\n", "utf8");
    writeFileSync(join(hooks, "pre-push"), DEFT_PRE_PUSH, "utf8");
    chmodSync(join(hooks, "pre-commit"), 0o755);
    chmodSync(join(hooks, "pre-push"), 0o755);
    const result = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: ".githooks", error: null }),
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("verify:branch");
  });

  it("fails when pre-push omits preflight-gh", () => {
    const root = makeRepo();
    const hooks = join(root, ".githooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-commit"), DEFT_PRE_COMMIT, "utf8");
    writeFileSync(join(hooks, "pre-push"), "deft verify:encoding\n", "utf8");
    chmodSync(join(hooks, "pre-commit"), 0o755);
    chmodSync(join(hooks, "pre-push"), 0o755);
    const result = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: ".githooks", error: null }),
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("preflight-gh");
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
    chmodSync(join(hooks, "pre-commit"), 0o644);
    chmodSync(join(hooks, "pre-push"), 0o644);
    const result = evaluate(root, {
      platform: "linux",
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
    chmodSync(join(hooks, "pre-commit"), 0o755);
    chmodSync(join(hooks, "pre-push"), 0o755);
    const result = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: ".githooks", error: null }),
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("verify:branch");
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

  it("fails when pre-push invokes verify:branch (#1814)", () => {
    const root = makeRepo();
    const hooks = join(root, ".githooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-commit"), DEFT_PRE_COMMIT, "utf8");
    writeFileSync(
      join(hooks, "pre-push"),
      "deft verify:branch --project-root x\ndeft preflight-gh --pre-push-stdin\n",
      "utf8",
    );
    chmodSync(join(hooks, "pre-commit"), 0o755);
    chmodSync(join(hooks, "pre-push"), 0o755);
    const result = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: ".githooks", error: null }),
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("pre-push must not invoke verify:branch");
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
});
