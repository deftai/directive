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

  it("runs against framework root", () => {
    const code = run(["--project-root", ".", "--quiet"]);
    expect([0, 1]).toContain(code);
  });
});
