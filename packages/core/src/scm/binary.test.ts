import { describe, expect, it } from "vitest";
import {
  buildWin32CmdLine,
  defaultWhich,
  escapeWin32CmdArg,
  preferWin32WhichHit,
  resolveBinary,
  scmSpawnNeedsShell,
} from "./binary.js";
import { BINARY_PREFERENCE } from "./constants.js";
import { ScmStubError } from "./errors.js";

describe("resolveBinary", () => {
  it("prefers ghx when both are on PATH", () => {
    const whichFn = (name: string) => `/usr/bin/${name}`;
    expect(resolveBinary(whichFn)).toBe("ghx");
  });

  it("falls back to gh when ghx is absent", () => {
    const whichFn = (name: string) => (name === "gh" ? "/usr/local/bin/gh" : null);
    expect(resolveBinary(whichFn)).toBe("gh");
  });

  it("raises ScmStubError when neither binary is present", () => {
    expect(() => resolveBinary(() => null)).toThrow(ScmStubError);
    expect(() => resolveBinary(() => null)).toThrow(/neither 'ghx' nor 'gh'/);
    // #2275: fail-loud diagnostic names execution-env boundary + SCM gates.
    expect(() => resolveBinary(() => null)).toThrow(/#2275|execution env|SCM-dependent/);
  });

  it("pins the preference order", () => {
    expect(BINARY_PREFERENCE[0]).toBe("ghx");
    expect(BINARY_PREFERENCE[1]).toBe("gh");
  });

  it("defaultWhich returns null for missing commands", () => {
    expect(defaultWhich("definitely-not-a-real-binary-xyz")).toBeNull();
  });
});

describe("preferWin32WhichHit (#5081)", () => {
  it("prefers same-dir .cmd over an extensionless shim", () => {
    expect(
      preferWin32WhichHit(
        ["C:\\shim\\gh", "C:\\shim\\gh.cmd", "C:\\Program Files\\GitHub CLI\\gh.exe"],
        "win32",
      ),
    ).toBe("C:\\shim\\gh.cmd");
  });

  it("keeps first-dir .exe and does not jump to a later PATH entry", () => {
    expect(
      preferWin32WhichHit(["C:\\Program Files\\GitHub CLI\\gh.exe", "C:\\shim\\gh.cmd"], "win32"),
    ).toBe("C:\\Program Files\\GitHub CLI\\gh.exe");
  });

  it("returns the first line on non-win32", () => {
    expect(preferWin32WhichHit(["/usr/bin/gh", "/usr/local/bin/gh"], "linux")).toBe("/usr/bin/gh");
  });
});

describe("scmSpawnNeedsShell (#5081)", () => {
  it("requires shell for win32 .cmd and .bat paths", () => {
    expect(scmSpawnNeedsShell("C:\\shim\\gh.cmd", "win32")).toBe(true);
    expect(scmSpawnNeedsShell("C:\\shim\\gh.CMD", "win32")).toBe(true);
    expect(scmSpawnNeedsShell("C:\\shim\\tool.bat", "win32")).toBe(true);
  });

  it("does not require shell for win32 .exe or bare names", () => {
    expect(scmSpawnNeedsShell("C:\\Program Files\\GitHub CLI\\gh.exe", "win32")).toBe(false);
    expect(scmSpawnNeedsShell("gh", "win32")).toBe(false);
  });

  it("never requires shell on non-win32", () => {
    expect(scmSpawnNeedsShell("/tmp/gh.cmd", "linux")).toBe(false);
    expect(scmSpawnNeedsShell("/tmp/gh.bat", "darwin")).toBe(false);
  });
});

describe("escapeWin32CmdArg / buildWin32CmdLine (#5081)", () => {
  it("quotes args that contain cmd metacharacters", () => {
    expect(escapeWin32CmdArg("plain")).toBe("plain");
    expect(escapeWin32CmdArg("a&b")).toBe('"a&b"');
    expect(escapeWin32CmdArg('say "hi"')).toBe('"say ""hi"""');
  });

  it("builds a single /c line with a quoted .cmd path and escaped args", () => {
    expect(buildWin32CmdLine("C:\\shim\\gh.cmd", ["api", "user", "a&b"])).toBe(
      'C:\\shim\\gh.cmd api user "a&b"',
    );
    expect(buildWin32CmdLine("C:\\Program Files\\GitHub CLI\\gh.cmd", ["auth", "status"])).toBe(
      '"C:\\Program Files\\GitHub CLI\\gh.cmd" auth status',
    );
  });
});
