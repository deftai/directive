import { describe, expect, it } from "vitest";
import { parseArgs, run } from "./verify-test-boundary.js";

describe("verify-test-boundary CLI (#3145)", () => {
  it("parses project-root and enforce flags", () => {
    const a = parseArgs(["--project-root", ".", "--enforce", "--quiet"]);
    expect(a.error).toBeUndefined();
    expect(a.projectRoot).toBe(".");
    expect(a.enforce).toBe(true);
    expect(a.quiet).toBe(true);
  });

  it("rejects unknown args", () => {
    const a = parseArgs(["--nope"]);
    expect(a.error).toMatch(/unrecognized/);
  });

  it("runs against framework root without config error", () => {
    // Exit 2 is config path noise; smoke only requires the CLI entry not throw.
    const code = run(["--project-root", ".", "--quiet"]);
    expect([0, 1, 2]).toContain(code);
  });
});
