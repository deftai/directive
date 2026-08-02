import { runXbriefCreateCli } from "@deftai/directive-core/dist/xbrief/index.js";
import { describe, expect, it } from "vitest";

describe("xbrief-create CLI wrapper (#3057)", () => {
  it("exposes create help via shared CLI entry", () => {
    const result = runXbriefCreateCli(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("xbrief:create");
  });
});
