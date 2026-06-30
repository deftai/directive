import { describe, expect, it } from "vitest";
import { isPatchOnlyUpgrade, parseSemverPrefix } from "./version.js";

describe("parseSemverPrefix", () => {
  it("parses semver markers with or without a v prefix", () => {
    expect(parseSemverPrefix("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseSemverPrefix("0.61.0")).toEqual([0, 61, 0]);
  });

  it("returns null for non-semver inputs", () => {
    expect(parseSemverPrefix("0.0.0-dev")).toBeNull();
    expect(parseSemverPrefix("not-a-version")).toBeNull();
  });
});

describe("isPatchOnlyUpgrade", () => {
  it("detects strict patch bumps", () => {
    expect(isPatchOnlyUpgrade("0.61.0", "0.61.1")).toBe(true);
    expect(isPatchOnlyUpgrade("1.0.0", "1.0.9")).toBe(true);
  });

  it("rejects minor, major, and same-version pairs", () => {
    expect(isPatchOnlyUpgrade("0.60.0", "0.61.0")).toBe(false);
    expect(isPatchOnlyUpgrade("0.61.0", "1.0.0")).toBe(false);
    expect(isPatchOnlyUpgrade("0.61.1", "0.61.1")).toBe(false);
    expect(isPatchOnlyUpgrade(null, "0.61.1")).toBe(false);
  });
});
