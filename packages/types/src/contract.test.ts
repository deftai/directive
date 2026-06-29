import { describe, expect, it } from "vitest";
import {
  collectExtensionProperties,
  EXTENSION_KEY_PATTERN,
  isExtensionKey,
  isVBriefReferenceType,
  VALID_STATUSES,
  VBRIEF_VERSION,
} from "./index.js";

describe("@deftai/directive-types contract surface (#1799)", () => {
  it("exports v0.6 version constant", () => {
    expect(VBRIEF_VERSION).toBe("0.6");
  });

  it("exports nine lifecycle statuses matching schema enum", () => {
    expect(VALID_STATUSES).toHaveLength(9);
    expect(VALID_STATUSES).toContain("failed");
  });

  it("recognizes vBRIEF#12 extension keys", () => {
    expect(isExtensionKey("x-directive/trace")).toBe(true);
    expect(isExtensionKey("plan")).toBe(false);
    expect(EXTENSION_KEY_PATTERN.test("x-vbrief/context")).toBe(true);
  });

  it("collects extension properties verbatim", () => {
    const collected = collectExtensionProperties({
      plan: { title: "t", status: "proposed", items: [] },
      "x-directive/trace": { id: "abc" },
    });
    expect(collected).toEqual({ "x-directive/trace": { id: "abc" } });
    expect(collected).not.toHaveProperty("plan");
  });

  it("accepts x-vbrief reference types", () => {
    expect(isVBriefReferenceType("x-vbrief/github-issue")).toBe(true);
    expect(isVBriefReferenceType("github-issue")).toBe(false);
  });
});
