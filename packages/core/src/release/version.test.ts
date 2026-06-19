import { describe, expect, it } from "vitest";
import {
  isPrereleaseTag,
  NonPublishableVersionError,
  toPep440,
  validateVersion,
} from "./version.js";

describe("validateVersion", () => {
  it.each(["0.0.0", "0.21.0", "1.2.3", "10.20.30"])("accepts %s", (v) => {
    expect(() => validateVersion(v)).not.toThrow();
  });

  it.each([
    "v0.21.0",
    "0.21",
    "0.21.0-rc.1",
    "0.21.0+build",
    "0.21.0.0",
    "abc",
    "",
  ])("rejects %s", (v) => {
    expect(() => validateVersion(v)).toThrow(/Invalid version/);
  });
});

describe("isPrereleaseTag", () => {
  it.each([
    ["v0.20.0-rc.1", true],
    ["0.20.0-beta.2", true],
    ["v0.20.0", false],
    ["0.20.0", false],
  ])("%s -> %s", (tag, expected) => {
    expect(isPrereleaseTag(tag)).toBe(expected);
  });
});

describe("toPep440", () => {
  it.each([
    ["v0.22.0", "0.22.0"],
    ["0.20.0-rc.3", "0.20.0rc3"],
    ["0.20.0-beta.2", "0.20.0b2"],
    ["0.20.0-alpha.1", "0.20.0a1"],
  ])("maps %s to %s", (input, expected) => {
    expect(toPep440(input)).toBe(expected);
  });

  it("raises NonPublishableVersionError for test tags", () => {
    expect(() => toPep440("0.0.0-test.1")).toThrow(NonPublishableVersionError);
  });

  it("rejects garbage input", () => {
    expect(() => toPep440("")).toThrow(/non-empty/);
    expect(() => toPep440("not-a-version")).toThrow(/Cannot normalize/);
  });
});
