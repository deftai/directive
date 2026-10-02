import { describe, expect, it } from "vitest";
import { parseArgs, run } from "./verify-scope-provenance.js";

describe("verify-scope-provenance CLI (#3145)", () => {
  it("parses base-ref and enforce", () => {
    const a = parseArgs(["--project-root=.", "--base-ref", "HEAD", "--enforce"]);
    expect(a.error).toBeUndefined();
    expect(a.baseRef).toBe("HEAD");
    expect(a.enforce).toBe(true);
  });

  it("rejects unknown args", () => {
    expect(parseArgs(["--bad"]).error).toMatch(/unrecognized/);
  });

  // evaluateScopeProvenance does git/membership work; under merge-gate load the
  // default 5s vitest budget flakes (PR #5244 Merge gate, twice).
  it("runs against framework root", { timeout: 20_000 }, () => {
    // Exit 2 is config/network (e.g. PR-aware base resolution) — still a successful CLI smoke.
    const code = run(["--project-root", ".", "--quiet", "--base-ref", "HEAD"]);
    expect([0, 1, 2]).toContain(code);
  });
});
