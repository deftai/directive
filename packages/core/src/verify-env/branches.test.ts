import * as childProcess from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultCommandRunner, runToolchainCheck } from "./toolchain-check.js";
import { evaluate } from "./verify-hooks-installed.js";
import { defaultPythonFiles, formatScanResult, scan } from "./verify-no-task-runtime.js";
import {
  defaultProbe,
  defaultRun,
  detectPlatform,
  verificationResultToJson,
  verifyRequiredTools,
} from "./verify-tools.js";

const temps: string[] = [];
afterEach(() => {
  for (const temp of temps) {
    rmSync(temp, { recursive: true, force: true });
  }
  temps.length = 0;
});

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-verify-env-branches-"));
  temps.push(root);
  return root;
}

describe("verify-tools branches", () => {
  it("covers install approval and failure paths", () => {
    const commands: string[][] = [];
    const result = verifyRequiredTools({
      install: true,
      assumeYes: true,
      includeTask: true,
      platformId: "linux",
      probe: (c) =>
        ["git", "uv", "python3", "gh", "apt-get"].includes(c) ? `/usr/bin/${c}` : null,
      runFn: (cmd) => {
        commands.push([...cmd]);
        return { returncode: 1, stdout: "", stderr: "install failed" };
      },
    });
    expect(result.exitCode).toBe(1);
    expect(commands.length).toBe(1);
  });

  it("covers declined install and interactive prompt headline", () => {
    const lines: string[] = [];
    const result = verifyRequiredTools({
      install: true,
      assumeYes: false,
      includeTask: true,
      platformId: "linux",
      probe: (c) =>
        ["git", "uv", "python3", "gh", "apt-get"].includes(c) ? `/usr/bin/${c}` : null,
      inputFn: () => "n",
      outputFn: (line) => {
        lines.push(line);
      },
    });
    expect(result.exitCode).toBe(1);
    expect(lines.some((line) => line.includes("Install it now? (Y/n)"))).toBe(true);
  });

  it("covers unknown platform manual-only guidance", () => {
    const lines: string[] = [];
    const result = verifyRequiredTools({
      platformId: "unknown",
      probe: (c) => (["git", "task", "python3", "gh"].includes(c) ? `/usr/bin/${c}` : null),
      outputFn: (line) => {
        lines.push(line);
      },
    });
    expect(result.exitCode).toBe(1);
    expect(lines.some((line) => line.includes("no safe automated"))).toBe(true);
  });

  it("covers detectPlatform branches", () => {
    expect(detectPlatform("win32")).toBe("windows");
    expect(detectPlatform("aix" as NodeJS.Platform)).toBe("unknown");
  });

  it("covers defaultProbe returning null", () => {
    expect(defaultProbe("definitely-not-a-real-binary-name-xyz")).toBeNull();
  });

  it("covers successful install after offer", () => {
    const available = new Set(["git", "uv", "python3", "gh", "apt-get"]);
    const result = verifyRequiredTools({
      install: true,
      assumeYes: true,
      includeTask: true,
      platformId: "linux",
      probe: (c) => (available.has(c) ? `/usr/bin/${c}` : null),
      runFn: (cmd) => {
        available.add("task");
        return { returncode: 0, stdout: "ok", stderr: "" };
      },
    });
    expect(result.exitCode).toBe(0);
  });

  it("covers yes input approval path", () => {
    const available = new Set(["git", "uv", "python3", "gh", "apt-get"]);
    const result = verifyRequiredTools({
      install: true,
      assumeYes: false,
      includeTask: true,
      platformId: "linux",
      probe: (c) => (available.has(c) ? `/usr/bin/${c}` : null),
      inputFn: () => "yes",
      runFn: () => {
        available.add("task");
        return { returncode: 0, stdout: "", stderr: "" };
      },
    });
    expect(result.exitCode).toBe(0);
  });

  it("covers defaultRun success and failure", () => {
    expect(defaultRun(["git", "--version"]).returncode).toBe(0);
    expect(defaultRun(["definitely-missing-binary-xyz"]).returncode).toBe(1);
  });

  it("covers install path using defaultRun when installer fails", () => {
    const result = verifyRequiredTools({
      install: true,
      assumeYes: true,
      includeTask: true,
      platformId: "linux",
      probe: (c) =>
        ["git", "uv", "python3", "gh", "apt-get"].includes(c) ? `/usr/bin/${c}` : null,
    });
    expect(result.exitCode).toBe(1);
  });

  it("covers windows package manager detection", () => {
    expect(
      verifyRequiredTools({
        platformId: "windows",
        probe: (c) => (["git", "uv", "python3", "gh", "winget"].includes(c) ? `/bin/${c}` : null),
      }).exitCode,
    ).toBe(0);
  });
});

describe("verify-hooks-installed branches", () => {
  it("covers missing hooks dir and hook files", () => {
    const root = makeRepo();
    const resultMissingDir = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: ".missing-hooks", error: null }),
    });
    expect(resultMissingDir.code).toBe(1);

    mkdirSync(join(root, ".githooks"), { recursive: true });
    const resultMissingHooks = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: ".githooks", error: null }),
    });
    expect(resultMissingHooks.code).toBe(1);
  });

  it("covers non-executable hooks on posix", () => {
    const root = makeRepo();
    const hooks = join(root, ".githooks");
    mkdirSync(hooks, { recursive: true });
    for (const name of ["pre-commit", "pre-push"]) {
      const hook = join(hooks, name);
      writeFileSync(hook, "#!/bin/sh\n", "utf8");
      chmodSync(hook, 0o644);
    }
    const scripts = join(root, "scripts");
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, "preflight_branch.py"), "#", "utf8");
    writeFileSync(join(scripts, "verify_encoding.py"), "#", "utf8");
    writeFileSync(join(scripts, "preflight_gh.py"), "#", "utf8");
    const result = evaluate(root, {
      platform: "linux",
      gitConfigReader: () => ({ hooksPath: ".githooks", error: null }),
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("not executable");
  });

  it("covers unresolved and partial gate scripts", () => {
    const root = makeRepo();
    const hooks = join(root, ".githooks");
    mkdirSync(hooks, { recursive: true });
    for (const name of ["pre-commit", "pre-push"]) {
      const hook = join(hooks, name);
      writeFileSync(hook, "#!/bin/sh\n", "utf8");
      chmodSync(hook, 0o755);
    }
    const unresolved = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: ".githooks", error: null }),
    });
    expect(unresolved.message).toContain("gate scripts cannot be resolved");

    const scripts = join(root, "scripts");
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, "preflight_branch.py"), "#", "utf8");
    const partial = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: ".githooks", error: null }),
    });
    expect(partial.message).toContain("verify_encoding.py");
  });

  it("reads hooks path via git config", () => {
    const root = makeRepo();
    const hooks = join(root, ".githooks");
    mkdirSync(hooks, { recursive: true });
    for (const name of ["pre-commit", "pre-push"]) {
      const hook = join(hooks, name);
      writeFileSync(hook, "#!/bin/sh\n", "utf8");
      chmodSync(hook, 0o755);
    }
    const scripts = join(root, "scripts");
    mkdirSync(scripts, { recursive: true });
    for (const name of ["preflight_branch.py", "verify_encoding.py", "preflight_gh.py"]) {
      writeFileSync(join(scripts, name), "#", "utf8");
    }
    childProcess.execFileSync("git", ["init", "-q"], { cwd: root });
    childProcess.execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: root });
    expect(evaluate(root).code).toBe(0);
  });

  it("skips posix exec-bit check on win32", () => {
    const root = makeRepo();
    const hooks = join(root, ".githooks");
    mkdirSync(hooks, { recursive: true });
    for (const name of ["pre-commit", "pre-push"]) {
      const hook = join(hooks, name);
      writeFileSync(hook, "#!/bin/sh\n", "utf8");
      chmodSync(hook, 0o644);
    }
    const scripts = join(root, "scripts");
    mkdirSync(scripts, { recursive: true });
    for (const name of ["preflight_branch.py", "verify_encoding.py", "preflight_gh.py"]) {
      writeFileSync(join(scripts, name), "#", "utf8");
    }
    const result = evaluate(root, {
      platform: "win32",
      gitConfigReader: () => ({ hooksPath: ".githooks", error: null }),
    });
    expect(result.code).toBe(0);
  });

  it("covers absolute hooks path and vendored scripts layout", () => {
    const root = makeRepo();
    const hooks = join(root, "custom-hooks");
    mkdirSync(hooks, { recursive: true });
    for (const name of ["pre-commit", "pre-push"]) {
      const hook = join(hooks, name);
      writeFileSync(hook, "#!/bin/sh\n", "utf8");
      chmodSync(hook, 0o755);
    }
    const scripts = join(root, ".deft", "core", "scripts");
    mkdirSync(scripts, { recursive: true });
    for (const name of ["preflight_branch.py", "verify_encoding.py", "preflight_gh.py"]) {
      writeFileSync(join(scripts, name), "#", "utf8");
    }
    const result = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: hooks, error: null }),
    });
    expect(result.code).toBe(0);
  });
});

describe("toolchain-check branches", () => {
  it("covers exception path", () => {
    const result = runToolchainCheck(() => ({ error: "exception", message: "boom" }));
    expect(result.exitCode).toBe(1);
    expect(result.lines.some((line) => line.includes("ERROR - boom"))).toBe(true);
  });

  it("covers non-zero command exit", () => {
    const result = runToolchainCheck(() => ({
      returncode: 2,
      stdout: "",
      stderr: "broken",
    }));
    expect(result.exitCode).toBe(1);
    expect(result.lines.some((line) => line.includes("FAILED (exit 2)"))).toBe(true);
  });

  it("exercises the default runner path", () => {
    const result = runToolchainCheck();
    expect(result.lines.length).toBeGreaterThan(1);
  });

  it("covers defaultCommandRunner failure branch", () => {
    const result = defaultCommandRunner(["/bin/false"], 1000);
    expect("returncode" in result && result.returncode).toBe(1);
  });

  it("covers defaultCommandRunner ENOENT branch", () => {
    const result = defaultCommandRunner(["definitely-missing-binary-xyz"], 1000);
    expect("error" in result && result.error).toBe("not-found");
  });
});

describe("verify-no-task-runtime branches", () => {
  it("lists default python files from repo root", () => {
    const root = makeRepo();
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "run"), "#", "utf8");
    writeFileSync(join(root, "scripts", "a.py"), "#", "utf8");
    writeFileSync(join(root, "scripts", "verify_no_task_runtime.py"), "#", "utf8");
    const files = defaultPythonFiles(root);
    expect(files.some((f) => f.endsWith("/run"))).toBe(true);
    expect(files.some((f) => f.endsWith("/a.py"))).toBe(true);
    expect(files.some((f) => f.endsWith("/verify_no_task_runtime.py"))).toBe(false);
  });

  it("covers unreadable file findings", () => {
    const root = makeRepo();
    const missing = scan({ root, pythonFiles: () => [join(root, "missing.py")] });
    expect(missing[0]?.message).toContain("ENOENT");
  });

  it("covers tuple first-arg subprocess alias", () => {
    const root = makeRepo();
    const probe = join(root, "probe.py");
    writeFileSync(
      probe,
      'from subprocess import run as run_process\nrun_process(("task", "check"))\n',
      "utf8",
    );
    expect(scan({ root, pythonFiles: () => [probe] })).toHaveLength(1);
  });

  it("covers direct shutil.which module call", () => {
    const root = makeRepo();
    const probe = join(root, "probe.py");
    writeFileSync(probe, 'import shutil\nshutil.which("task")\n', "utf8");
    expect(scan({ root, pythonFiles: () => [probe] })).toHaveLength(1);
  });

  it("covers default scan root without options", () => {
    expect(Array.isArray(scan())).toBe(true);
  });

  it("covers triple-quoted comment stripping", () => {
    const root = makeRepo();
    const probe = join(root, "probe.py");
    writeFileSync(
      probe,
      "x = '''# not a comment\nstill'''\nimport subprocess\nsubprocess.run([\"task\"])\n",
      "utf8",
    );
    expect(scan({ root, pythonFiles: () => [probe] })).toHaveLength(1);
  });
});
