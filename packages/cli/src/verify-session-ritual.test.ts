import { describe, expect, it } from "vitest";
import { parseArgs } from "./verify-session-ritual.js";

describe("parseArgs", () => {
  it("defaults to quick tier with project root .", () => {
    expect(parseArgs([])).toMatchObject({
      projectRoot: ".",
      tier: "quick",
      posture: null,
      emitJson: false,
    });
    expect(parseArgs([]).error).toBeUndefined();
  });

  it("parses --tier=gated", () => {
    expect(parseArgs(["--tier=gated"])).toMatchObject({ tier: "gated" });
    expect(parseArgs(["--tier=gated"]).error).toBeUndefined();
  });

  it("accepts a lone -- separator before flags (#2680)", () => {
    expect(parseArgs(["--", "--tier=gated"])).toMatchObject({ tier: "gated" });
    expect(parseArgs(["--", "--tier=gated"]).error).toBeUndefined();
    expect(parseArgs(["--", "--tier=gated"])).toEqual(parseArgs(["--tier=gated"]));
  });

  it("errors on missing values and unknown flags", () => {
    expect(parseArgs(["--tier"]).error).toBeDefined();
    expect(parseArgs(["--bogus"]).error).toBeDefined();
  });
});
