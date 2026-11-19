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
run_directive verify:branch --project-root "$REPO_ROOT" || exit $?
run_directive verify:encoding --staged --project-root "$REPO_ROOT" || exit $?
run_directive verify:forward-coverage --staged --project-root "$REPO_ROOT" || exit $?
if [ -d "$REPO_ROOT/xbrief" ] || [ -d "$REPO_ROOT/vbrief" ]; then
  run_directive verify:vbrief-conformance --staged --project-root "$REPO_ROOT" || exit $?
  run_directive verify:xbrief-drift --staged --project-root "$REPO_ROOT" || exit $?
fi
`;

const DEFT_PRE_PUSH = `#!/usr/bin/env sh
run_directive preflight-gh --pre-push-stdin --project-root "$REPO_ROOT" || exit $?
`;

/** The deposited git-hook template from setup-wiring.ts (#5808). */
function hookTemplate(name: "GITHOOK_HELPER" | "PRE_COMMIT" | "PRE_PUSH"): string {
  const src = readFileSync(join(REPO_ROOT, "packages/runtime/src/setup-wiring.ts"), "utf8");
  const open = `const ${name} = \``;
  const start = src.indexOf(open);
  expect(start, `${name} template in setup-wiring.ts`).toBeGreaterThanOrEqual(0);
  const body = src.slice(start + open.length);
  return body.slice(0, body.indexOf("`;"));
}

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

  it("fails when pre-push omits preflight-gh --pre-push-stdin", () => {
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
    expect(result.message).toContain("preflight-gh --pre-push-stdin");
  });

  it("fails on the thin 0.127 pre-commit that dropped the brief gates (#5808)", () => {
    const root = makeRepo();
    const hooks = makeDeftHooks(root);
    writeFileSync(
      join(hooks, "pre-commit"),
      '#!/usr/bin/env sh\nrun_directive verify:encoding --staged --project-root "$REPO_ROOT"\n',
      "utf8",
    );
    const result = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: ".githooks", error: null }),
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("verify:forward-coverage");
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

  it("passes the refspec-aware pre-push (#5808 / D-021)", () => {
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
    // The templates setup deposits, not this repo's pinned copies (DOGFOOD).
    writeFileSync(join(hooks, "pre-commit"), hookTemplate("PRE_COMMIT"), "utf8");
    writeFileSync(join(hooks, "pre-push"), hookTemplate("PRE_PUSH"), "utf8");
    writeFileSync(join(hooks, "_directive-run.sh"), hookTemplate("GITHOOK_HELPER"), "utf8");
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

describe("declared refusal hooks-installed (#6281 / #5977)", () => {
  it("every refusal names the gate id and a remedy that keeps the pin, never deft update", () => {
    const root = makeRepo();
    const unset = evaluate(root, { gitConfigReader: () => ({ hooksPath: null, error: null }) });
    const missingDir = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: ".githooks", error: null }),
    });
    const hooks = join(root, ".githooks");
    mkdirSync(hooks, { recursive: true });
    const missingHooks = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: ".githooks", error: null }),
    });
    writeFileSync(join(hooks, "pre-commit"), LEGACY_PYTHON_PRE_COMMIT, "utf8");
    writeFileSync(join(hooks, "pre-push"), DEFT_PRE_PUSH, "utf8");
    const nonExec = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: ".githooks", error: null }),
      platform: "linux",
      hookExecutable: () => false,
    });
    const content = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: ".githooks", error: null }),
      platform: "win32",
    });
    for (const result of [unset, missingDir, missingHooks, nonExec, content]) {
      expect(result.code).toBe(1);
      expect(result.message).toContain("deft gate hooks-installed ");
      expect(result.message).toContain("Remedy: `directive install --repair --yes`.");
      expect(result.message).not.toContain("deft update");
    }
    expect(content.message.split("\n").length).toBeGreaterThan(1);
  });

  it("in warn mode the check passes and still prints the gate id and remedy", () => {
    const root = makeRepo();
    const result = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: null, error: null }),
      refusalRows: [
        {
          id: "hooks-installed",
          gate: "verify:hooks-installed (#1463)",
          mode: "warn",
          remedy: ["directive install --repair --yes"],
          exception: null,
        },
      ],
    });
    expect(result.code).toBe(0);
    expect(result.message).toContain("can refuse from a later release");
    expect(result.message).toContain("`directive install --repair --yes`");
  });
});
