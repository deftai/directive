import { describe, expect, it } from "vitest";
import {
  ACCEPTED_VBRIEF_VERSIONS,
  collectExtensionProperties,
  EXTENSION_KEY_PATTERN,
  isExtensionKey,
  isVBriefReferenceType,
  VALID_STATUSES,
  VBRIEF_CORE_SCHEMA_ID,
  VBRIEF_VERSION,
  XBRIEF_REFERENCE_PREFIX,
} from "./index.js";

describe("@deftai/directive-types contract surface (#1799, #2107)", () => {
  it("exports v0.8 version constant pinned to xBRIEF schema", () => {
    expect(VBRIEF_VERSION).toBe("0.8");
    expect(ACCEPTED_VBRIEF_VERSIONS).toEqual(["0.6", "0.8"]);
    expect(VBRIEF_CORE_SCHEMA_ID).toBe("https://xbrief.dev/schemas/xbrief-core-0.8.schema.json");
  });

  it("exports nine lifecycle statuses matching plan-level schema enum", () => {
    expect(VALID_STATUSES).toHaveLength(9);
    expect(VALID_STATUSES).toContain("failed");
    expect(VALID_STATUSES).not.toContain("auto");
  });

  it("recognizes vBRIEF#12 extension keys", () => {
    expect(isExtensionKey("x-directive/trace")).toBe(true);
    expect(isExtensionKey("plan")).toBe(false);
    expect(EXTENSION_KEY_PATTERN.test("x-vbrief/context")).toBe(true);
    expect(EXTENSION_KEY_PATTERN.test("x-xbrief/context")).toBe(true);
  });

  it("collects extension properties verbatim", () => {
    const collected = collectExtensionProperties({
      plan: { title: "t", status: "proposed", items: [] },
      "x-directive/trace": { id: "abc" },
    });
    expect(collected).toEqual({ "x-directive/trace": { id: "abc" } });
    expect(collected).not.toHaveProperty("plan");
  });

  it("accepts x-vbrief and x-xbrief reference types", () => {
    expect(isVBriefReferenceType("x-vbrief/github-issue")).toBe(true);
    expect(isVBriefReferenceType(`${XBRIEF_REFERENCE_PREFIX}github-issue`)).toBe(true);
    expect(isVBriefReferenceType("github-issue")).toBe(false);
  });
});
