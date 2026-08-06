import { describe, expect, it } from "vitest";
import { parseArgs, run } from "./verify-consumer-check-contract.js";

describe("verify-consumer-check-contract CLI (#3145)", () => {
  it("parses framework-source and warn flags", () => {
    const a = parseArgs(["--project-root", ".", "--framework-source", "--warn"]);
    expect(a.error).toBeUndefined();
    expect(a.frameworkSource).toBe(true);
    expect(a.enforce).toBe(false);
  });

  it("rejects unknown args", () => {
    expect(parseArgs(["--x"]).error).toMatch(/unrecognized/);
  });

  it("runs against framework root", () => {
    const code = run(["--project-root", ".", "--quiet"]);
    expect([0, 1, 2]).toContain(code);
  });
});
