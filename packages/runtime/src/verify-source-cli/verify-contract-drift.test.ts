import { describe, expect, it } from "vitest";
import { parseArgs, run } from "./verify-contract-drift.js";

describe("verify-contract-drift CLI", () => {
  it("parseArgs rejects unknown flags", () => {
    expect(parseArgs(["--nope"]).error).toContain("unrecognized");
  });

  it("run returns config error when schemas are absent", () => {
    expect(run(["--project-root", "/nonexistent-contract-drift-root"])).toBe(2);
  });
});
