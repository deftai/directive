import { describe, expect, it } from "vitest";
import {
  resolveCommandOnPath,
  shouldUseShellForCommand,
  spawnCommandText,
} from "./command-spawn.js";

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

describe("spawnCommandText (#2548)", () => {
  it("surfaces a non-empty stderr when the spawn itself errors", () => {
    const result = spawnCommandText("deft-nonexistent-binary-xyz-2548", ["api"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr.trim().length).toBeGreaterThan(0);
  });
});
