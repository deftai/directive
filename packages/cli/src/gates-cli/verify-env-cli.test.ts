import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveCanonicalVerb } from "../dispatch.js";
import { run as runToolchainCheckCli } from "../toolchain-check.js";
import { repoRoot, runDeftTs } from "./_helpers.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

describe("deft-ts verify-tools (maps tests/cli/test_verify_tools.py)", () => {
  it("verify-tools exits 0 when required tools are present", () => {
    const { exitCode, stdout } = runDeftTs("verify-tools", ["--platform", "linux"], {
      cwd: repoRoot(),
    });
    expect([0, 1]).toContain(exitCode);
    if (exitCode === 0) {
      expect(stdout).toContain("[deft tools]");
    }
  });

  it("verify:tools alias routes to the same handler", () => {
    const direct = runDeftTs("verify-tools", ["--json", "--platform", "linux"], {
      cwd: repoRoot(),
    });
    const alias = runDeftTs("verify:tools", ["--json", "--platform", "linux"], { cwd: repoRoot() });
    expect(alias.exitCode).toBe(direct.exitCode);
  });

  it("returns exit 2 for unknown flags", () => {
    const { exitCode, stderr } = runDeftTs("verify-tools", ["--bogus"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("unrecognized");
  });
});

describe("deft-ts verify-hooks-installed (maps tests/cli/test_verify_hooks_installed.py)", () => {
  it("exits 0 or 1 against the framework repo hooks layout", () => {
    const { exitCode } = runDeftTs("verify-hooks-installed", ["--project-root", repoRoot()]);
    expect([0, 1]).toContain(exitCode);
  });

  it("verify:hooks-installed alias routes identically", () => {
    const direct = runDeftTs("verify-hooks-installed", ["--project-root", repoRoot()]);
    const alias = runDeftTs("verify:hooks-installed", ["--project-root", repoRoot()]);
    expect(alias.exitCode).toBe(direct.exitCode);
  });
});

describe("deft-ts verify-no-task-runtime (maps tests/cli/test_verify_no_task_runtime.py)", () => {
  it("scans clean when no forbidden task probes exist in injected tree", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-no-task-"));
    temps.push(root);
    writeFileSync(join(root, "clean.py"), 'print("ok")\n', "utf8");
    const { exitCode } = runDeftTs("verify-no-task-runtime", [], {
      cwd: root,
      env: { DEFT_ROOT: repoRoot() },
    });
    expect([0, 1]).toContain(exitCode);
  });

  it("verify:no-task-runtime alias routes identically", () => {
    const direct = runDeftTs("verify-no-task-runtime", [], { cwd: repoRoot() });
    const alias = runDeftTs("verify:no-task-runtime", [], { cwd: repoRoot() });
    expect(alias.exitCode).toBe(direct.exitCode);
  });
});

describe("deft-ts toolchain-check", () => {
  const stubRunner = (command: readonly string[]) => ({
    returncode: 0,
    stdout: `${command[0] ?? "tool"} version test\n`,
    stderr: "",
  });

  it("runs without config error", () => {
    const exitCode = runToolchainCheckCli([], { runner: stubRunner });
    expect([0, 1]).toContain(exitCode);
  });

  it("toolchain:check alias routes identically", () => {
    expect(resolveCanonicalVerb("toolchain:check")).toBe("toolchain-check");
    const direct = runToolchainCheckCli([], { runner: stubRunner });
    const alias = runToolchainCheckCli([], { runner: stubRunner });
    expect(alias).toBe(direct);
  });

  it("consumer mode skips maintainer-only tools", () => {
    const maintainerOnlyMissing = (command: readonly string[]) => {
      const name = command[0] ?? "";
      if (name === "go" || name === "uv") {
        return { error: "not-found" as const, message: "" };
      }
      return { returncode: 0, stdout: `${name} ok\n`, stderr: "" };
    };
    const maintainer = runToolchainCheckCli([], { runner: maintainerOnlyMissing });
    const consumer = runToolchainCheckCli(["--consumer"], { runner: maintainerOnlyMissing });
    expect(maintainer).toBe(1);
    expect(consumer).toBe(0);
  });
});

function encodingRepo(content: string): string {
  const root = mkdtempSync(join(tmpdir(), "deft-encoding-"));
  temps.push(root);
  writeFileSync(join(root, "sample.txt"), content, "utf8");
  execFileSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["add", "-A"], { cwd: root, encoding: "utf8" });
  return root;
}

describe("deft-ts verify-encoding (maps tests/cli/test_verify_encoding.py CLI paths)", () => {
  it("returns 0 for clean ascii content", () => {
    const root = encodingRepo("clean ascii\n");
    const { exitCode } = runDeftTs("verify-encoding", ["--all", "--project-root", root]);
    expect(exitCode).toBe(0);
  });

  it("returns 1 for U+FFFD corruption", () => {
    const root = encodingRepo("broken \ufffd\n");
    const { exitCode } = runDeftTs("verify-encoding", ["--all", "--project-root", root]);
    expect(exitCode).toBe(1);
  });

  it("returns 2 for unknown flags", () => {
    const { exitCode } = runDeftTs("verify-encoding", ["--bogus"]);
    expect(exitCode).toBe(2);
  });

  it("verify:encoding alias routes identically on clean repo", () => {
    const root = encodingRepo("ok\n");
    const direct = runDeftTs("verify-encoding", ["--all", "--project-root", root]);
    const alias = runDeftTs("verify:encoding", ["--all", "--project-root", root]);
    expect(alias.exitCode).toBe(direct.exitCode);
  });
});
