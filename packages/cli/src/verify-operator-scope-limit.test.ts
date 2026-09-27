import { describe, expect, it } from "vitest";
import { parseArgs, run } from "./verify-operator-scope-limit.js";

describe("verify-operator-scope-limit CLI (#4545)", () => {
  it("parseArgs requires prompt input and rejects unknown flags", () => {
    expect(parseArgs(["--quiet"]).prompt).toBeUndefined();
    expect(parseArgs(["--prompt", "do not add extras"]).prompt).toBe("do not add extras");
    expect(parseArgs(["--bogus"]).error).toMatch(/unrecognized/);
  });

  it("run exits 2 without a prompt and 0 when ceiling seeds cleanly", () => {
    expect(run([])).toBe(2);
    expect(run(["--prompt", "add vehicle\n\ninitial version only", "--quiet"])).toBe(0);
  });
});
