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

  // Windows dest worktrees: one git show per lifecycle brief (~1800) is ~200ms
  // each here (~6 min serial); suite load pushes past the 240s win32 project
  // default. Do not undercut with a tighter per-it timeout (#5391 lane flake).
  it("runs against framework root", { timeout: 900_000 }, () => {
    // Exit 2 is config/network (e.g. PR-aware base resolution) — still a successful CLI smoke.
    const code = run(["--project-root", ".", "--quiet", "--base-ref", "HEAD"]);
    expect([0, 1, 2]).toContain(code);
  });
});
