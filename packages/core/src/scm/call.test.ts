import { describe, expect, it } from "vitest";

// /bin/true is Unix-only; on Windows use `where` (always present) as a no-op binary.
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
      binary: "/bin/true",
      captureOutput: true,
    });
    expect(result.args).toEqual(["/bin/true", "auth"]);
    expect(result.returncode).toBe(0);
  });
});
