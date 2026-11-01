import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The explicit no-op fixture is Unix-only; skip this assertion on Windows.
const itNotWin32 = it.skipIf(process.platform === "win32");

import { call } from "./call.js";
import { ScmStubError } from "./errors.js";

describe("call", () => {
  it("raises NotImplementedError for unsupported sources", () => {
    for (const source of ["gitlab", "gitea", "local", "bitbucket", ""]) {
      expect(() => call(source, "issue", ["view", "1"])).toThrow(/not yet supported/);
      expect(() => call(source, "issue", ["view", "1"])).toThrow(/#445/);
    }
  });

  it("raises ScmStubError when neither binary is on PATH", () => {
    expect(() => call("github-issue", "issue", ["list"], { whichFn: () => null })).toThrow(
      ScmStubError,
    );
  });

  itNotWin32("uses explicit binary override without PATH lookup", () => {
    const result = call("github-issue", "auth", [], {
      binary: "/usr/bin/true",
      captureOutput: true,
    });
    expect(result.args).toEqual(["/usr/bin/true", "auth"]);
    expect(result.returncode).toBe(0);
  });

  it("captures stdout larger than Node's 1 MB default (#3903)", () => {
    // The paginated open-issue inventory of a large repo runs to several MB;
    // 2 MB overflows the 1 MB default that aborted the capture with ENOBUFS.
    const bytes = 2 * 1024 * 1024;
    const result = call("github-issue", "-e", [`process.stdout.write("x".repeat(${bytes}))`], {
      binary: process.execPath,
    });
    expect(result.returncode).toBe(0);
    expect(result.stdout.length).toBe(bytes);
    expect(result.stderr).toBe("");
  });

  it("reports a non-empty reason when the spawn itself fails (#3903)", () => {
    // A spawn-level failure returns status null with no stderr; without the
    // error.message fallback the caller sees a bare exit 1 and no reason.
    const result = call("github-issue", "api", [], {
      binary: "deft-nonexistent-binary-xyz",
    });
    expect(result.returncode).toBe(1);
    expect(result.stderr.trim().length).toBeGreaterThan(0);
  });
});

const COLOR_GH_STUB = resolve(
  import.meta.dirname,
  "..",
  "pr-protected-issues",
  "fixtures",
  "color-gh-stub.mjs",
);
const ISSUE_PATH = "repos/deftai/directive/issues/6023";

describe("call plain gh env (#6023)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns parseable JSON under CLICOLOR_FORCE=1 when the caller passes no env", () => {
    vi.stubEnv("CLICOLOR_FORCE", "1");
    vi.stubEnv("NO_COLOR", "");
    const result = call("github-issue", COLOR_GH_STUB, ["api", ISSUE_PATH], {
      binary: process.execPath,
    });
    expect(result.returncode).toBe(0);
    expect(result.stdout).not.toContain("\u001b");
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload.state).toBe("closed");
    expect(payload.stubNoColor).toBe("1");
    expect(process.env.CLICOLOR_FORCE).toBe("1");
  });

  it("passes an explicit caller env through unchanged (contract, not the bug)", () => {
    const result = call("github-issue", COLOR_GH_STUB, ["api", ISSUE_PATH], {
      binary: process.execPath,
      env: { ...process.env, CLICOLOR_FORCE: "1" },
    });
    expect(result.returncode).toBe(0);
    expect(result.stdout).toContain("\u001b");
  });
});
