import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatNamedCauseFailure } from "../check/named-cause.js";
import { NODE_RUNTIME_REMEDIATION, NPM_RUNTIME_REMEDIATION } from "./node-runtime.js";
import {
  CONSUMER_TOOLS,
  childEnvWithResolvedPackageManagerShim,
  defaultCommandRunner,
  RESOLVED_PACKAGE_MANAGER_SHIM_ENV,
  runToolchainCheck,
} from "./toolchain-check.js";

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function consumerFixture(packageManager: string, pnpmLockPresent = false): string {
  const root = mkdtempSync(join(tmpdir(), "deft-toolchain-consumer-"));
  fixtureRoots.push(root);
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ packageManager })}\n`, "utf8");
  if (pnpmLockPresent) {
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  }
  return root;
}

describe("runToolchainCheck", () => {
  it("reports all tools available on success", () => {
    const result = runToolchainCheck((command) => ({
      returncode: 0,
      stdout: `${command[0]} version test\n`,
      stderr: "",
    }));
    expect(result.exitCode).toBe(0);
    expect(result.lines.at(-1)).toBe("All required tools available");
  });

  it("reports missing tools with exit 1", () => {
    const result = runToolchainCheck(() => ({ error: "not-found", message: "" }));
    expect(result.exitCode).toBe(1);
    expect(result.lines.some((line) => line.includes("Missing tools:"))).toBe(true);
  });

  it("reports command failures", () => {
    const result = runToolchainCheck(() => ({
      returncode: 1,
      stdout: "",
      stderr: "failed",
    }));
    expect(result.exitCode).toBe(1);
    expect(result.lines.some((line) => line.includes("FAILED"))).toBe(true);
  });

  it("sanitizes and bounds command-runner exception messages", () => {
    const result = runToolchainCheck(() => ({
      error: "exception",
      message: `failure\u009b31mRED\u202eBIDI\u0085INJECTED_BLOCK${"x".repeat(300)}`,
    }));
    const errorLines = result.lines.filter((line) => line.includes(": ERROR"));
    expect(errorLines.length).toBeGreaterThan(0);
    expect(errorLines.every((line) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(line))).toBe(true);
    expect(errorLines.every((line) => line.includes("failure 31mRED BIDI"))).toBe(true);
    expect(errorLines.every((line) => !line.includes("INJECTED_BLOCK"))).toBe(true);
    expect(errorLines.every((line) => line.length < 280)).toBe(true);
  });

  it("emits node runtime remediation when node or pnpm is missing", () => {
    const result = runToolchainCheck((command) => {
      const name = command[0] ?? "";
      if (name === "node" || name === "pnpm") {
        return { error: "not-found", message: "" };
      }
      return { returncode: 0, stdout: `${name} version test\n`, stderr: "" };
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines).toContain(NODE_RUNTIME_REMEDIATION);
  });

  it("does not emit node remediation when only unrelated tools are missing", () => {
    const result = runToolchainCheck((command) => {
      const name = command[0] ?? "";
      if (name === "go") {
        return { error: "not-found", message: "" };
      }
      return { returncode: 0, stdout: `${name} version test\n`, stderr: "" };
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines).not.toContain(NODE_RUNTIME_REMEDIATION);
  });

  it("consumer mode probes shared tools plus the declared npm, never pnpm or go-task (#3610)", () => {
    const projectRoot = consumerFixture("npm@11.16.0", true);
    const seen: string[] = [];
    const probeRoots: Array<string | undefined> = [];
    const result = runToolchainCheck(
      (command, _timeoutMs, options) => {
        seen.push(command[0] ?? "");
        probeRoots.push(options?.cwd);
        return { returncode: 0, stdout: "ok\n", stderr: "" };
      },
      { consumer: true, projectRoot, env: {} },
    );
    expect(result.exitCode).toBe(0);
    expect(seen).toEqual([...CONSUMER_TOOLS.map((tool) => tool.command[0]), "npm"]);
    expect(seen).not.toContain("go");
    expect(seen).not.toContain("uv");
    expect(seen).not.toContain("pnpm");
    expect(seen).not.toContain("task");
    expect(seen).toContain("gh");
    const ghIndex = seen.indexOf("gh");
    expect(probeRoots[ghIndex]).toBeUndefined();
    expect(
      probeRoots.every((root, index) =>
        seen[index] === "gh" ? root === undefined : root === projectRoot,
      ),
    ).toBe(true);
    expect(result.lines.join("\n")).toMatch(/package manager: npm.*packageManager field/i);
  });

  it("probes pnpm for a pnpm-pinned consumer", () => {
    const projectRoot = consumerFixture("pnpm@11.8.0");
    const seen: string[] = [];
    const result = runToolchainCheck(
      (command) => {
        seen.push(command[0] ?? "");
        return { returncode: 0, stdout: "ok\n", stderr: "" };
      },
      { consumer: true, projectRoot, env: {} },
    );
    expect(result.exitCode).toBe(0);
    expect(seen).toContain("pnpm");
    expect(seen).not.toContain("npm");
    expect(seen).not.toContain("task");
  });

  it("does not invoke a Corepack-rejected pnpm shim in an npm-pinned fixture", () => {
    const projectRoot = consumerFixture("npm@11.16.0");
    const seen: string[] = [];
    const result = runToolchainCheck(
      (command) => {
        const name = command[0] ?? "";
        seen.push(name);
        if (name === "pnpm") {
          return {
            returncode: 1,
            stdout: "",
            stderr:
              'This project is configured to use npm because package.json has a "packageManager" field',
          };
        }
        return { returncode: 0, stdout: `${name} ok\n`, stderr: "" };
      },
      { consumer: true, projectRoot, env: {} },
    );
    expect(result.exitCode).toBe(0);
    expect(seen).not.toContain("pnpm");
    expect(seen).toContain("npm");
  });

  it("fails before execution for an unsupported or instruction-shaped declaration", () => {
    const projectRoot = consumerFixture("pnpm@11.8.0; touch should-not-run");
    const seen: string[][] = [];
    const result = runToolchainCheck(
      (command) => {
        seen.push([...command]);
        return { returncode: 0, stdout: "ok\n", stderr: "" };
      },
      { consumer: true, projectRoot, env: {} },
    );
    expect(result.exitCode).toBe(1);
    expect(seen).toEqual([]);
    expect(result.lines.join("\n")).toMatch(/unsupported package manager/i);
    expect(result.lines.join("\n")).not.toContain("touch should-not-run --version");
  });

  it("emits npm-specific remediation without telling an npm project to enable pnpm", () => {
    const projectRoot = consumerFixture("npm@11.16.0");
    const result = runToolchainCheck(
      (command) =>
        command[0] === "npm"
          ? { error: "not-found" as const, message: "" }
          : { returncode: 0, stdout: "ok\n", stderr: "" },
      { consumer: true, projectRoot, env: {} },
    );
    expect(result.exitCode).toBe(1);
    expect(result.lines).toContain(NPM_RUNTIME_REMEDIATION);
    expect(result.lines).not.toContain(NODE_RUNTIME_REMEDIATION);
    expect(result.lines.join("\n")).not.toMatch(/corepack.*pnpm/i);
  });

  it("routes real consumer output to the failing npm cause and remedy", () => {
    const projectRoot = consumerFixture("npm@11.16.0");
    const check = runToolchainCheck(
      (command) =>
        command[0] === "npm"
          ? { error: "not-found" as const, message: "" }
          : { returncode: 0, stdout: "ok\n", stderr: "" },
      { consumer: true, projectRoot, env: {} },
    );
    const named = formatNamedCauseFailure({
      gateId: "toolchain:check-consumer",
      exitCode: check.exitCode,
      stdout: check.lines.join("\n"),
    });
    expect(named.cause).toMatch(/^npm: NOT FOUND$/i);
    expect(named.remedy).toMatch(/npm is bundled/i);
    expect(named.remedy).not.toMatch(/pnpm|corepack/i);
  });

  it("surfaces a real Corepack mismatch diagnostic from a nonzero manager probe", () => {
    const projectRoot = consumerFixture("pnpm@11.8.0");
    const result = runToolchainCheck(
      (command) =>
        command[0] === "pnpm"
          ? {
              returncode: 1,
              stdout: "",
              stderr: "This project is configured to use npm",
            }
          : { returncode: 0, stdout: "ok\n", stderr: "" },
      { consumer: true, projectRoot, env: {} },
    );
    expect(result.lines.join("\n")).toMatch(
      /pnpm: FAILED \(exit 1\) - This project is configured to use npm/,
    );
  });

  it("renders command output without Unicode line, terminal, or bidi controls", () => {
    const projectRoot = consumerFixture("pnpm@11.8.0");
    const result = runToolchainCheck(
      (command) =>
        command[0] === "pnpm"
          ? {
              returncode: 1,
              stdout: "",
              stderr: "failure\u009b31mRED\u202eBIDI\u0085INJECTED_BLOCK",
            }
          : { returncode: 0, stdout: "ok\u009b0m\u202e\nINJECTED_SUCCESS", stderr: "" },
      { consumer: true, projectRoot, env: {} },
    );
    const output = result.lines.join("\n");
    expect(result.lines.every((line) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(line))).toBe(true);
    expect(output).toContain("failure 31mRED BIDI");
    expect(output).not.toContain("INJECTED_BLOCK");
    expect(output).not.toContain("INJECTED_SUCCESS");
  });

  it.each(["darwin", "linux"] as const)("runs %s commands without a shell", (platform) => {
    const shells: boolean[] = [];
    const result = defaultCommandRunner(["npm", "--version"], 1_000, {
      platform,
      execFileSync: (_bin, _args, options) => {
        shells.push(options.shell);
        return "11.16.0\n";
      },
    });
    expect(result).toMatchObject({ returncode: 0, stdout: "11.16.0\n" });
    expect(shells).toEqual([false]);
  });

  it("runs a trusted absolute Windows .cmd/PATHEXT shim through child-env transport", () => {
    const calls: Array<{
      bin: string;
      args: readonly string[];
      shell: boolean;
      windowsVerbatimArguments?: boolean;
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    }> = [];
    const managerPath = "C:\\Program Files\\nodejs\\npm.CMD";
    const result = defaultCommandRunner(["npm", "--version"], 1_000, {
      platform: "win32",
      cwd: "C:\\consumer",
      env: { Path: "C:\\Program Files\\nodejs", PATHEXT: ".CMD", SystemRoot: "C:\\Windows" },
      exists: (path) => path === managerPath,
      execFileSync: (bin, args, options) => {
        calls.push({
          bin,
          args,
          shell: options.shell,
          windowsVerbatimArguments: options.windowsVerbatimArguments,
          cwd: options.cwd,
          env: options.env,
        });
        return "11.16.0\r\n";
      },
    });
    expect(result).toMatchObject({ returncode: 0, stdout: "11.16.0\r\n" });
    expect(calls).toEqual([
      {
        bin: "C:\\Windows\\System32\\cmd.exe",
        args: ["/d", "/s", "/c", '""%DEFT_RESOLVED_PACKAGE_MANAGER_SHIM%" --version"'],
        shell: false,
        windowsVerbatimArguments: true,
        cwd: "C:\\consumer",
        env: childEnvWithResolvedPackageManagerShim(
          { Path: "C:\\Program Files\\nodejs", PATHEXT: ".CMD", SystemRoot: "C:\\Windows" },
          managerPath,
        ),
      },
    ]);
    expect(calls[0]?.env?.[RESOLVED_PACKAGE_MANAGER_SHIM_ENV]).toBe(managerPath);
    expect(calls[0]?.args.join(" ")).not.toContain("C:\\consumer\\npm");
  });

  it("transports percent-containing shim paths without cmd expansion", () => {
    const managerPath = "C:\\Users\\50%off\\npm.CMD";
    const result = defaultCommandRunner(["npm", "--version"], 1_000, {
      platform: "win32",
      cwd: "C:\\consumer",
      env: { Path: "C:\\Users\\50%off", PATHEXT: ".CMD", SystemRoot: "C:\\Windows" },
      exists: (path) => path === managerPath,
      execFileSync: (_bin, _args, options) => {
        expect(options.env?.[RESOLVED_PACKAGE_MANAGER_SHIM_ENV]).toBe(managerPath);
        return "11.16.0\r\n";
      },
    });
    expect(result).toMatchObject({ returncode: 0 });
  });

  it("clears inherited case-insensitive shim transport env keys before setting", () => {
    const managerPath = "C:\\trusted\\npm.CMD";
    const evilPath = "C:\\evil\\npm.CMD";
    defaultCommandRunner(["npm", "--version"], 1_000, {
      platform: "win32",
      env: {
        Path: "C:\\trusted",
        PATHEXT: ".CMD",
        SystemRoot: "C:\\Windows",
        deft_resolved_package_manager_shim: evilPath,
      },
      exists: (path) => path === managerPath,
      execFileSync: (_bin, _args, options) => {
        expect(options.env?.[RESOLVED_PACKAGE_MANAGER_SHIM_ENV]).toBe(managerPath);
        expect(options.env?.deft_resolved_package_manager_shim).toBeUndefined();
        return "11.16.0\r\n";
      },
    });
  });

  it.runIf(process.platform === "win32")(
    "executes a real Windows .cmd shim from a spaced PATH directory",
    () => {
      const shimRoot = mkdtempSync(join(tmpdir(), "deft toolchain shim-"));
      fixtureRoots.push(shimRoot);
      writeFileSync(join(shimRoot, "npm.cmd"), "@echo off\r\necho 11.16.0\r\n", "utf8");

      const result = defaultCommandRunner(["npm", "--version"], 1_000, {
        cwd: shimRoot,
        env: {
          ...process.env,
          PATH: shimRoot,
          Path: shimRoot,
          PATHEXT: ".CMD",
        },
      });

      expect(shimRoot).toContain(" ");
      expect(result).toMatchObject({ returncode: 0 });
      expect("stdout" in result ? result.stdout.trim() : "").toBe("11.16.0");
    },
  );

  it("never shell-retries arbitrary Windows argv", () => {
    const shells: boolean[] = [];
    const result = defaultCommandRunner(["npm", "--version & should-not-run"], 1_000, {
      platform: "win32",
      execFileSync: (_bin, _args, options) => {
        shells.push(options.shell);
        throw Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" });
      },
    });
    expect(result).toEqual({ error: "not-found", message: "" });
    expect(shells).toEqual([false]);
  });

  it("preserves a Windows shim's real Corepack failure instead of relabeling it not-found", () => {
    const managerPath = "C:\\trusted\\pnpm.CMD";
    const result = defaultCommandRunner(["pnpm", "--version"], 1_000, {
      platform: "win32",
      env: { Path: "C:\\trusted", PATHEXT: ".CMD", SystemRoot: "C:\\Windows" },
      exists: (path) => path === managerPath,
      execFileSync: () => {
        throw Object.assign(new Error("Corepack mismatch"), {
          status: 1,
          stdout: "",
          stderr: "This project is configured to use npm",
        });
      },
    });
    expect(result).toEqual({
      returncode: 1,
      stdout: "",
      stderr: "This project is configured to use npm",
    });
  });

  it("does not execute a repo-local Windows manager when PATH has no trusted candidate", () => {
    let called = false;
    const result = defaultCommandRunner(["npm", "--version"], 1_000, {
      platform: "win32",
      cwd: "C:\\consumer",
      env: { Path: "C:\\trusted", PATHEXT: ".CMD", SystemRoot: "C:\\Windows" },
      exists: () => false,
      execFileSync: () => {
        called = true;
        return "unexpected";
      },
    });
    expect(result).toEqual({ error: "not-found", message: "" });
    expect(called).toBe(false);
  });

  it("warns when captured gh --version is below the GHSA token-masking floor (#3664 R3)", () => {
    const result = runToolchainCheck((command) => {
      const name = command[0] ?? "";
      if (name === "gh") {
        return {
          returncode: 0,
          stdout:
            "gh version 2.88.1 (2026-03-12)\nhttps://github.com/cli/cli/releases/tag/v2.88.1\n",
          stderr: "",
        };
      }
      return { returncode: 0, stdout: `${name} version test\n`, stderr: "" };
    });
    expect(result.exitCode).toBe(0);
    const advisory = result.lines.filter((line) => line.includes("gh advisory:"));
    expect(advisory).toHaveLength(1);
    expect(advisory[0]).toContain("GHSA-cg6r-mpgc-h9mm");
    expect(advisory[0]).toContain("CVE-2026-64652");
    expect(advisory[0]).toContain("2.97.0");
    expect(advisory[0]).toContain(
      "https://github.com/cli/cli/security-advisories/GHSA-cg6r-mpgc-h9mm",
    );
    expect(advisory[0]).not.toContain("gh auth status");
  });

  it("does not warn when captured gh --version meets the advisory floor (#3664 R3)", () => {
    const result = runToolchainCheck((command) => {
      const name = command[0] ?? "";
      if (name === "gh") {
        return { returncode: 0, stdout: "gh version 2.97.0\n", stderr: "" };
      }
      return { returncode: 0, stdout: `${name} version test\n`, stderr: "" };
    });
    expect(result.exitCode).toBe(0);
    expect(result.lines.some((line) => line.includes("gh advisory:"))).toBe(false);
  });

  it("surfaces ETIMEDOUT when gh --version times out with empty stdio (#3610)", () => {
    const result = defaultCommandRunner(["gh", "--version"], 1_000, {
      execFileSync: () => {
        throw Object.assign(new Error("spawnSync gh ETIMEDOUT"), {
          code: "ETIMEDOUT",
          status: null,
          stdout: "",
          stderr: "",
        });
      },
    });
    expect(result).toMatchObject({ returncode: 1 });
    expect("stderr" in result ? result.stderr : "").toContain("ETIMEDOUT");
  });

  it("retries gh --version once after ETIMEDOUT (#3610)", () => {
    let calls = 0;
    const result = defaultCommandRunner(["gh", "--version"], 1_000, {
      execFileSync: () => {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error("spawnSync gh ETIMEDOUT"), {
            code: "ETIMEDOUT",
            status: null,
            stdout: "",
            stderr: "",
          });
        }
        return "gh version 2.101.0 (2026-09-15)\n";
      },
    });
    expect(calls).toBe(2);
    expect(result).toMatchObject({
      returncode: 0,
      stdout: "gh version 2.101.0 (2026-09-15)\n",
    });
  });

  it("does not retry gh --version when stderr has a real diagnostic (#3610)", () => {
    let calls = 0;
    const result = defaultCommandRunner(["gh", "--version"], 1_000, {
      execFileSync: () => {
        calls += 1;
        throw Object.assign(new Error("failed"), {
          status: 1,
          stdout: "",
          stderr: "unknown command",
        });
      },
    });
    expect(calls).toBe(1);
    expect(result).toEqual({ returncode: 1, stdout: "", stderr: "unknown command" });
  });

  it("does not retry git --version after ETIMEDOUT (#3610)", () => {
    let calls = 0;
    const result = defaultCommandRunner(["git", "--version"], 1_000, {
      execFileSync: () => {
        calls += 1;
        throw Object.assign(new Error("spawnSync git ETIMEDOUT"), {
          code: "ETIMEDOUT",
          status: null,
          stdout: "",
          stderr: "",
        });
      },
    });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ returncode: 1 });
  });

  it("resolves Windows gh.exe on PATH and sets GH_NO_UPDATE_NOTIFIER (#3610)", () => {
    const ghPath = "C:\\Program Files\\GitHub CLI\\gh.EXE";
    const calls: Array<{
      bin: string;
      args: readonly string[];
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    }> = [];
    const result = defaultCommandRunner(["gh", "--version"], 1_000, {
      platform: "win32",
      cwd: "C:\\consumer",
      env: {
        Path: "C:\\Program Files\\GitHub CLI",
        PATHEXT: ".EXE",
        SystemRoot: "C:\\Windows",
      },
      exists: (path) => path === ghPath,
      execFileSync: (bin, args, options) => {
        calls.push({ bin, args, cwd: options.cwd, env: options.env });
        return "gh version 2.101.0 (2026-09-15)\n";
      },
    });
    expect(result).toMatchObject({
      returncode: 0,
      stdout: "gh version 2.101.0 (2026-09-15)\n",
    });
    expect(calls).toEqual([
      {
        bin: ghPath,
        args: ["--version"],
        cwd: undefined,
        env: expect.objectContaining({ GH_NO_UPDATE_NOTIFIER: "1" }),
      },
    ]);
    expect(calls[0]?.bin).not.toBe("gh");
  });
});
