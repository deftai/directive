import { describe, expect, it } from "vitest";
import { probeRuntimeCapabilities, reportToDict } from "./platform-capabilities.js";
import {
  detectEnvironmentContext,
  environmentContextToDict,
  formatEnvironmentContext,
} from "./shell-context.js";

describe("detectEnvironmentContext", () => {
  it("prefers the harness-provided execution shell and preserves attribution", () => {
    expect(
      detectEnvironmentContext({
        environ: {
          DEFT_EXECUTION_SHELL: "/opt/homebrew/bin/bash",
          SHELL: "/bin/zsh",
        },
        platform: "darwin",
        userShell: "/bin/fish",
      }),
    ).toEqual({
      hostPlatform: "darwin",
      shell: {
        name: "bash",
        path: "/opt/homebrew/bin/bash",
        kind: "execution",
        source: "DEFT_EXECUTION_SHELL",
      },
    });
  });

  it("reports SHELL as a default shell rather than the current executor", () => {
    expect(
      detectEnvironmentContext({
        environ: { SHELL: "/bin/zsh" },
        platform: "darwin",
        userShell: "/bin/fish",
      }).shell,
    ).toEqual({ name: "zsh", path: "/bin/zsh", kind: "default", source: "SHELL" });
  });

  it("falls back to the POSIX account shell", () => {
    expect(
      detectEnvironmentContext({ environ: {}, platform: "linux", userShell: "/usr/bin/fish" })
        .shell,
    ).toEqual({
      name: "fish",
      path: "/usr/bin/fish",
      kind: "default",
      source: "os.userInfo().shell",
    });
  });

  it("uses os.userInfo when neither userShell nor readUserShell is supplied (#2666)", () => {
    const context = detectEnvironmentContext({ environ: {}, platform: "linux" });
    expect(
      context.shell.source === "os.userInfo().shell" || context.shell.source === "unknown",
    ).toBe(true);
  });

  it("reads the POSIX account shell through the injectable platform seam", () => {
    expect(
      detectEnvironmentContext({
        environ: {},
        platform: "linux",
        readUserShell: () => "/bin/dash",
      }).shell,
    ).toEqual({
      name: "dash",
      path: "/bin/dash",
      kind: "default",
      source: "os.userInfo().shell",
    });
  });

  it("reports unknown when account-shell lookup throws", () => {
    expect(
      detectEnvironmentContext({
        environ: {},
        platform: "linux",
        readUserShell: () => {
          throw new Error("account database unavailable");
        },
      }).shell,
    ).toEqual({ name: "unknown", path: null, kind: "unknown", source: "unknown" });
  });

  it("reports unknown when account-shell lookup is empty", () => {
    expect(
      detectEnvironmentContext({ environ: {}, platform: "linux", readUserShell: () => "" }).shell,
    ).toEqual({ name: "unknown", path: null, kind: "unknown", source: "unknown" });
  });

  it("falls back to ComSpec and normalizes a Windows executable name", () => {
    expect(
      detectEnvironmentContext({
        environ: { ComSpec: "C:\\Windows\\System32\\cmd.EXE" },
        platform: "win32",
        userShell: "/bin/ignored",
      }).shell,
    ).toEqual({
      name: "cmd",
      path: "C:\\Windows\\System32\\cmd.EXE",
      kind: "default",
      source: "ComSpec",
    });
  });

  it("accepts the uppercase COMSPEC spelling", () => {
    expect(
      detectEnvironmentContext({
        environ: { COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
        platform: "win32",
      }).shell.source,
    ).toBe("ComSpec");
  });

  it("supports a bare shell name without inventing a path", () => {
    expect(
      detectEnvironmentContext({
        environ: { DEFT_EXECUTION_SHELL: "pwsh" },
        platform: "win32",
        userShell: null,
      }).shell,
    ).toEqual({
      name: "pwsh",
      path: null,
      kind: "execution",
      source: "DEFT_EXECUTION_SHELL",
    });
  });

  it.each([
    ["./bash", "bash"],
    ["../bin/zsh", "zsh"],
    ["relative\\pwsh", "pwsh"],
  ])("does not surface a relative shell candidate %j as a validated path", (candidate, name) => {
    expect(
      detectEnvironmentContext({
        environ: { DEFT_EXECUTION_SHELL: candidate },
        platform: "linux",
        userShell: null,
      }).shell,
    ).toEqual({
      name,
      path: null,
      kind: "execution",
      source: "DEFT_EXECUTION_SHELL",
    });
  });

  it("skips invalid higher-precedence candidates", () => {
    expect(
      detectEnvironmentContext({
        environ: {
          DEFT_EXECUTION_SHELL: "/bin/bash\nforged-output",
          SHELL: "/bin/zsh",
        },
        platform: "darwin",
        userShell: "/bin/fish",
      }).shell,
    ).toEqual({ name: "zsh", path: "/bin/zsh", kind: "default", source: "SHELL" });
  });

  it("rejects overlong candidates and reports unknown without guessing", () => {
    expect(
      detectEnvironmentContext({
        environ: { DEFT_EXECUTION_SHELL: `/bin/${"x".repeat(4097)}` },
        platform: "freebsd",
        userShell: null,
      }).shell,
    ).toEqual({ name: "unknown", path: null, kind: "unknown", source: "unknown" });
  });

  it.each(["   ", "/", ".", "..", ".exe"])("rejects an invalid shell basename %j", (invalid) => {
    expect(
      detectEnvironmentContext({
        environ: { DEFT_EXECUTION_SHELL: invalid },
        platform: "linux",
        userShell: null,
      }).shell.source,
    ).toBe("unknown");
  });

  it.each([
    ...Array.from({ length: 32 }, (_, codePoint) => codePoint),
    ...Array.from({ length: 33 }, (_, offset) => 127 + offset),
    0x2028,
    0x2029,
  ])("rejects shell candidates containing control character U+%i", (codePoint) => {
    const malformed = `/bin/zsh${String.fromCharCode(codePoint)}`;
    const context = detectEnvironmentContext({
      environ: { DEFT_EXECUTION_SHELL: malformed, SHELL: "/bin/fish" },
      platform: "linux",
      userShell: null,
    });
    expect(context.shell.source).toBe("SHELL");
    expect(context.shell.name).toBe("fish");
  });

  it("formats safe human and machine contracts", () => {
    const context = detectEnvironmentContext({
      environ: { SHELL: "/bin/zsh" },
      platform: "darwin",
      userShell: null,
    });
    expect(formatEnvironmentContext(context)).toBe(
      "[deft environment] os=darwin; shell=zsh; kind=default; path=/bin/zsh; source=SHELL",
    );
    expect(environmentContextToDict(context)).toEqual({
      host_platform: "darwin",
      shell: { name: "zsh", path: "/bin/zsh", kind: "default", source: "SHELL" },
    });
  });

  it("quotes ambiguous values and formats an unknown path explicitly", () => {
    const spaced = detectEnvironmentContext({
      environ: { SHELL: "/tmp dir/zsh" },
      platform: "darwin",
      userShell: null,
    });
    expect(formatEnvironmentContext(spaced)).toContain('path="/tmp dir/zsh"');
    const unknown = detectEnvironmentContext({
      environ: {},
      platform: "aix",
      userShell: null,
    });
    expect(formatEnvironmentContext(unknown)).toBe(
      "[deft environment] os=aix; shell=unknown; kind=unknown; path=unknown; source=unknown",
    );
  });
});

describe("platform capability shell composition", () => {
  it("includes shell orientation in the typed and dictionary reports", () => {
    const report = probeRuntimeCapabilities({
      environ: { SHELL: "/bin/zsh" },
      platform: "darwin",
      userShell: null,
      uidMapPath: "/none",
      cwd: "/none",
      effectiveUidOverride: 1000,
    });
    expect(report.hostPlatform).toBe("darwin");
    expect(report.shell.source).toBe("SHELL");
    expect(reportToDict(report)).toMatchObject({
      host_platform: "darwin",
      shell: { name: "zsh", path: "/bin/zsh", kind: "default", source: "SHELL" },
    });
  });
});
