import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

import { spawnSync } from "node:child_process";
import {
  POWERSHELL_RESTRICTED_CMD_RECOVERY,
  probePowershellBinReachability,
  quoteWin32CommandForShell,
  resolveCommandOnPath,
  shouldUseShellForCommand,
  spawnCommandText,
} from "./command-spawn.js";

const mockSpawnSync = vi.mocked(spawnSync);
const WINDOWS_SEPARATOR = String.fromCharCode(92);

function windowsPath(segments: readonly string[]): string {
  return segments.join(WINDOWS_SEPARATOR);
}

beforeEach(() => {
  mockSpawnSync.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shouldUseShellForCommand (#2548)", () => {
  it("uses a shell for Windows command shims", () => {
    expect(shouldUseShellForCommand(windowsPath(["C:", "bin", "pnpm.CMD"]), "win32")).toBe(true);
    expect(shouldUseShellForCommand(windowsPath(["C:", "bin", "pnpm.bat"]), "win32")).toBe(true);
  });

  it("does not use a shell for native executables or non-Windows platforms", () => {
    expect(shouldUseShellForCommand(windowsPath(["C:", "bin", "pnpm.EXE"]), "win32")).toBe(false);
    expect(shouldUseShellForCommand("/usr/bin/pnpm", "linux")).toBe(false);
    expect(shouldUseShellForCommand("/usr/bin/pnpm")).toBe(false);
  });
});

describe("resolveCommandOnPath (#2548)", () => {
  it("returns null when PATH is empty", () => {
    expect(resolveCommandOnPath("pnpm", { env: { PATH: "" }, platform: "linux" })).toBeNull();
    expect(resolveCommandOnPath("pnpm", { env: {}, platform: "linux" })).toBeNull();
  });

  it("finds pnpm on a posix PATH", () => {
    const found = resolveCommandOnPath("pnpm", {
      env: { PATH: "/empty:/usr/local/bin" },
      platform: "linux",
      exists: (p) => p === "/usr/local/bin/pnpm",
    });
    expect(found).toBe("/usr/local/bin/pnpm");
  });

  it("prefers pnpm.cmd over a bare extensionless shim on win32", () => {
    const found = resolveCommandOnPath("pnpm", {
      env: {
        Path: windowsPath(["C:", "Users", "msada", "AppData", "Roaming", "npm"]),
        PATHEXT: ".EXE;.CMD",
      },
      platform: "win32",
      exists: (p) => p.endsWith("pnpm.CMD") || p.endsWith(`${WINDOWS_SEPARATOR}pnpm`),
    });
    expect(found?.endsWith("pnpm.CMD")).toBe(true);
  });

  it("falls back to a default PATHEXT on win32 when unset", () => {
    const found = resolveCommandOnPath("pnpm", {
      env: { Path: windowsPath(["C:", "bin"]) },
      platform: "win32",
      exists: (p) => p.endsWith(".EXE"),
    });
    expect(found?.endsWith("pnpm.EXE")).toBe(true);
  });

  it("skips empty PATH segments and supports default resolution options", () => {
    const found = resolveCommandOnPath("deft-hook", {
      env: { PATH: ":/bin" },
      platform: "linux",
      exists: (path) => path === "/bin/deft-hook",
    });

    expect(found).toBe("/bin/deft-hook");
    expect(resolveCommandOnPath("definitely-not-a-real-command-deft-3100")).toBeNull();
  });
});

describe("quoteWin32CommandForShell (#2555)", () => {
  it("quotes spaced paths on win32", () => {
    const command = windowsPath(["C:", "Program Files", "nodejs", "npm.cmd"]);
    expect(quoteWin32CommandForShell(command, "win32")).toBe(`"${command}"`);
  });

  it("leaves unspaced paths and non-win32 platforms unchanged", () => {
    const command = windowsPath(["C:", "bin", "pnpm.CMD"]);
    expect(quoteWin32CommandForShell(command, "win32")).toBe(command);
    expect(quoteWin32CommandForShell("/usr/bin/npm", "linux")).toBe("/usr/bin/npm");
  });

  it("does not double-quote already quoted paths", () => {
    const command = windowsPath(["C:", "Program Files", "npm.cmd"]);
    const doubleQuoted = `"${command}"`;
    const singleQuoted = `'${command}'`;
    expect(quoteWin32CommandForShell(doubleQuoted, "win32")).toBe(doubleQuoted);
    expect(quoteWin32CommandForShell(singleQuoted, "win32")).toBe(singleQuoted);
  });
});

describe("spawnCommandText (#2548 / #2555)", () => {
  it("surfaces a non-empty stderr when the spawn itself errors", () => {
    const result = spawnCommandText("deft-nonexistent-binary-xyz-2548", ["api"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr.trim().length).toBeGreaterThan(0);
  });

  it("quotes Program Files-style .cmd paths when shell is required (#2555)", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: "",
      stderr: "",
      pid: 1,
      output: [null, "", ""] as [null, string, string],
      signal: null,
      error: undefined,
    });

    const npmCmd = windowsPath(["C:", "Program Files", "nodejs", "npm.cmd"]);
    spawnCommandText(npmCmd, ["publish", "--dry-run"]);

    expect(mockSpawnSync).toHaveBeenCalledWith(
      `"${npmCmd}"`,
      ["publish", "--dry-run"],
      expect.objectContaining({ shell: true, windowsHide: true }),
    );
  });

  it("does not quote unspaced pnpm.cmd paths (#2548 / #2555)", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: "",
      stderr: "",
      pid: 1,
      output: [null, "", ""] as [null, string, string],
      signal: null,
      error: undefined,
    });

    const pnpmCmd = windowsPath(["C:", "bin", "pnpm.CMD"]);
    spawnCommandText(pnpmCmd, ["install"]);

    expect(mockSpawnSync).toHaveBeenCalledWith(
      pnpmCmd,
      ["install"],
      expect.objectContaining({ shell: true, windowsHide: true }),
    );
  });

  it("retries a Windows ENOENT spawn through the shell", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mockSpawnSync
      .mockReturnValueOnce({
        status: null,
        stdout: "",
        stderr: "",
        pid: 1,
        output: [null, "", ""] as [null, string, string],
        signal: null,
        error: Object.assign(new Error("missing"), { code: "ENOENT" }),
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: "ok",
        stderr: "",
        pid: 2,
        output: [null, "ok", ""] as [null, string, string],
        signal: null,
        error: undefined,
      });

    expect(
      spawnCommandText(windowsPath(["C:", "bin", "deft-hook"]), [], {
        env: { PATH: windowsPath(["C:", "bin"]) },
      }),
    ).toEqual({ status: 0, stdout: "ok", stderr: "" });
    expect(mockSpawnSync).toHaveBeenCalledTimes(2);
    expect(mockSpawnSync.mock.calls[1]?.[2]).toEqual(expect.objectContaining({ shell: true }));
  });

  it("maps a signal-terminated process to status 128", () => {
    mockSpawnSync.mockReturnValueOnce({
      status: null,
      stdout: Buffer.from("partial"),
      stderr: Buffer.from(""),
      pid: 1,
      output: [null, Buffer.from("partial"), Buffer.from("")],
      signal: "SIGTERM",
      error: undefined,
    });

    expect(spawnCommandText("deft-hook", [])).toEqual({ status: 128, stdout: "", stderr: "" });
  });

  it("maps a status-less process without a signal or error to success", () => {
    mockSpawnSync.mockReturnValueOnce({
      status: null,
      stdout: "",
      stderr: "",
      pid: 1,
      output: [null, "", ""] as [null, string, string],
      signal: null,
      error: undefined,
    });

    expect(spawnCommandText("deft-hook", [], { timeoutMs: 10 })).toEqual({
      status: 0,
      stdout: "",
      stderr: "",
    });
  });
});

describe("probePowershellBinReachability (#4659)", () => {
  it("skips on non-windows", () => {
    expect(probePowershellBinReachability("deft-hook", { platform: "linux" })).toEqual({
      ok: true,
      skipped: true,
      source: null,
      detail: "non-windows",
    });
  });

  it("rejects unsafe command names", () => {
    expect(probePowershellBinReachability("deft-hook; rm", { platform: "win32" }).ok).toBe(false);
  });

  it("fails closed when Get-Command selects a .ps1 under Restricted", () => {
    const spawnSyncFn = vi.fn(() => ({
      status: 0,
      stdout: "SRC|C:\\npm\\deft-hook.ps1\n",
      stderr: "",
      error: undefined,
      signal: null,
      output: [],
      pid: 1,
    })) as unknown as typeof import("node:child_process").spawnSync;
    const result = probePowershellBinReachability("deft-hook", {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      spawnSyncFn,
    });
    expect(result.ok).toBe(false);
    expect(result.source?.toLowerCase().endsWith(".ps1")).toBe(true);
    expect(POWERSHELL_RESTRICTED_CMD_RECOVERY).toMatch(/#4654/);
    expect(POWERSHELL_RESTRICTED_CMD_RECOVERY).toMatch(/Do not set ExecutionPolicy Bypass/);
  });

  it("passes when Restricted Get-Command selects .cmd even if --help exits 2", () => {
    // Real deft-hook.cmd rejects --help with exit 2; that must not fail the probe.
    const spawnSyncFn = vi.fn(() => ({
      status: 2,
      stdout: "SRC|C:\\npm\\deft-hook.cmd\n",
      stderr: "unrecognized argument: --help\n",
      error: undefined,
      signal: null,
      output: [],
      pid: 1,
    })) as unknown as typeof import("node:child_process").spawnSync;
    const result = probePowershellBinReachability("deft-hook", {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      spawnSyncFn,
    });
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        skipped: false,
        source: expect.stringMatching(/\.cmd$/i),
      }),
    );
  });

  it("names Restricted policy refusal without recommending Bypass", () => {
    const spawnSyncFn = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr: "PSSecurityException: running scripts is disabled",
      error: undefined,
      signal: null,
      output: [],
      pid: 1,
    })) as unknown as typeof import("node:child_process").spawnSync;
    const result = probePowershellBinReachability("deft-hook", {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      spawnSyncFn,
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/Restricted|\.ps1/i);
    expect(POWERSHELL_RESTRICTED_CMD_RECOVERY).toMatch(/postinstall|\.cmd|#4654/);
  });
});
