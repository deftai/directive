import { describe, expect, it } from "vitest";
import { parseArgs, run } from "./verify-observable-scope.js";

describe("verify-observable-scope CLI (#4495)", () => {
  it("parses --origin-ref and refuses --base-ref", () => {
    const parsed = parseArgs(["--project-root", ".", "--origin-ref", "origin/master"]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.originRef).toBe("origin/master");
    expect(parseArgs(["--base-ref", "HEAD"]).error).toMatch(/merge base/);
  });

  it("returns 2 on unrecognized arguments", () => {
    expect(run(["--nope"])).toBe(2);
  });
});
