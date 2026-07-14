import { describe, expect, it } from "vitest";

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
});
