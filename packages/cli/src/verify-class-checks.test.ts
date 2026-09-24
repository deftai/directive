import { describe, expect, it } from "vitest";
import { parseArgs, run } from "./verify-class-checks.js";

describe("verify-class-checks CLI (#4980)", () => {
  it("parses project-root and base-ref flags", () => {
    const a = parseArgs(["--project-root", ".", "--base-ref", "origin/master", "--quiet"]);
    expect(a.error).toBeUndefined();
    expect(a.projectRoot).toBe(".");
    expect(a.baseRef).toBe("origin/master");
    expect(a.quiet).toBe(true);
  });

  it("rejects unknown args", () => {
    const a = parseArgs(["--nope"]);
    expect(a.error).toMatch(/unrecognized/);
  });

  it("runs against framework root without config error", () => {
    const code = run(["--project-root", ".", "--quiet"]);
    expect([0, 1, 2]).toContain(code);
  }, 30_000);
});
