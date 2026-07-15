import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

import { spawnSync } from "node:child_process";
import {
  quoteWin32CommandForShell,
  resolveCommandOnPath,
  shouldUseShellForCommand,
  spawnCommandText,
} from "./command-spawn.js";

const mockSpawnSync = vi.mocked(spawnSync);

beforeEach(() => {
  mockSpawnSync.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shouldUseShellForCommand (#2548)", () => {
  it("uses a shell for Windows command shims", () => {
    expect(shouldUseShellForCommand("C:\\bin\\pnpm.CMD", "win32")).toBe(true);
    expect(shouldUseShellForCommand("C:\\bin\\pnpm.bat", "win32")).toBe(true);
  });

  it("does not use a shell for native executables or non-Windows platforms", () => {
    expect(shouldUseShellForCommand("C:\\bin\\pnpm.EXE", "win32")).toBe(false);
    expect(shouldUseShellForCommand("/usr/bin/pnpm", "linux")).toBe(false);
  });
});

describe("resolveCommandOnPath (#2548)", () => {
  it("returns null when PATH is empty", () => {
    expect(resolveCommandOnPath("pnpm", { env: { PATH: "" }, platform: "linux" })).toBeNull();
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
      env: { Path: "C:\\Users\\msada\\AppData\\Roaming\\npm", PATHEXT: ".EXE;.CMD" },
      platform: "win32",
      exists: (p) => p.endsWith("pnpm.CMD") || p.endsWith("\\pnpm"),
    });
    expect(found?.endsWith("pnpm.CMD")).toBe(true);
  });

  it("falls back to a default PATHEXT on win32 when unset", () => {
    const found = resolveCommandOnPath("pnpm", {
      env: { Path: "C:\\bin" },
      platform: "win32",
      exists: (p) => p.endsWith(".EXE"),
    });
    expect(found?.endsWith("pnpm.EXE")).toBe(true);
  });
});

describe("quoteWin32CommandForShell (#2555)", () => {
  it("quotes spaced paths on win32", () => {
    expect(quoteWin32CommandForShell("C:\\Program Files\\nodejs\\npm.cmd", "win32")).toBe(
      '"C:\\Program Files\\nodejs\\npm.cmd"',
    );
  });

  it("leaves unspaced paths and non-win32 platforms unchanged", () => {
    expect(quoteWin32CommandForShell("C:\\bin\\pnpm.CMD", "win32")).toBe("C:\\bin\\pnpm.CMD");
    expect(quoteWin32CommandForShell("/usr/bin/npm", "linux")).toBe("/usr/bin/npm");
  });

  it("does not double-quote already quoted paths", () => {
    expect(quoteWin32CommandForShell('"C:\\Program Files\\npm.cmd"', "win32")).toBe(
      '"C:\\Program Files\\npm.cmd"',
    );
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

    const npmCmd = "C:\\Program Files\\nodejs\\npm.cmd";
    spawnCommandText(npmCmd, ["publish", "--dry-run"]);

    expect(mockSpawnSync).toHaveBeenCalledWith(
      `"${npmCmd}"`,
      ["publish", "--dry-run"],
      expect.objectContaining({ shell: true }),
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

    const pnpmCmd = "C:\\bin\\pnpm.CMD";
    spawnCommandText(pnpmCmd, ["install"]);

    expect(mockSpawnSync).toHaveBeenCalledWith(
      pnpmCmd,
      ["install"],
      expect.objectContaining({ shell: true }),
    );
  });
});
