import { runXbriefVerifyCli } from "@deftai/directive-core/dist/xbrief/index.js";
import { describe, expect, it } from "vitest";

describe("xbrief-verify CLI wrapper (#3057)", () => {
  it("exposes verify help via shared CLI entry", () => {
    const result = runXbriefVerifyCli(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("xbrief:verify");
  });
});
