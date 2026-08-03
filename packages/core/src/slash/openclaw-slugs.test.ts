import { describe, expect, it } from "vitest";
import {
  assertOpenClawSlugMapIntegrity,
  isValidOpenClawSlug,
  listOpenClawSlugEntries,
  logicalIdToOpenClawSlug,
  OPENCLAW_LOGICAL_ID_BY_SLUG,
  OPENCLAW_ROUTER_SLUG,
  OPENCLAW_SLUG_BY_LOGICAL_ID,
  OPENCLAW_SLUG_MAX_LEN,
  openClawSlugToLogicalId,
} from "./openclaw-slugs.js";
import { listProductCommands, PRODUCT_COMMAND_COUNT } from "./product-set.js";

describe("OpenClaw L2 slug map (#3064 D2)", () => {
  it("covers exactly the L2 product set of 13 with bijective map", () => {
    expect(() => assertOpenClawSlugMapIntegrity()).not.toThrow();
    const entries = listOpenClawSlugEntries();
    expect(entries).toHaveLength(PRODUCT_COMMAND_COUNT);
    expect(Object.keys(OPENCLAW_SLUG_BY_LOGICAL_ID)).toHaveLength(PRODUCT_COMMAND_COUNT);

    const slugs = entries.map((e) => e.openClawSlug);
    expect(new Set(slugs).size).toBe(PRODUCT_COMMAND_COUNT);

    for (const e of entries) {
      expect(openClawSlugToLogicalId(e.openClawSlug)).toBe(e.logicalId);
      expect(logicalIdToOpenClawSlug(e.logicalId)).toBe(e.openClawSlug);
      expect(OPENCLAW_LOGICAL_ID_BY_SLUG[e.openClawSlug]).toBe(e.logicalId);
    }
  });

  it("sanitizes to a-z0-9_ max 32 and never includes colons", () => {
    for (const e of listOpenClawSlugEntries()) {
      expect(isValidOpenClawSlug(e.openClawSlug)).toBe(true);
      expect(e.openClawSlug.length).toBeLessThanOrEqual(OPENCLAW_SLUG_MAX_LEN);
      expect(e.openClawSlug).not.toContain(":");
      expect(e.openClawSlug).toMatch(/^[a-z0-9_]+$/);
    }
    expect(isValidOpenClawSlug(OPENCLAW_ROUTER_SLUG)).toBe(true);
    expect(isValidOpenClawSlug("bad:colon")).toBe(false);
    expect(isValidOpenClawSlug("A")).toBe(false);
    expect(isValidOpenClawSlug("x".repeat(OPENCLAW_SLUG_MAX_LEN + 1))).toBe(false);
  });

  it("matches D2 example pattern for interview", () => {
    expect(logicalIdToOpenClawSlug("/deft:directive:run:interview")).toBe("deft_run_interview");
  });

  it("aligns map keys with listProductCommands (no second name table)", () => {
    const logicalIds = listProductCommands().map((c) => c.logicalId);
    expect(listOpenClawSlugEntries().map((e) => e.logicalId)).toEqual(logicalIds);
  });

  it("reserves router slug outside the product set", () => {
    const productSlugs = new Set(listOpenClawSlugEntries().map((e) => e.openClawSlug));
    expect(productSlugs.has(OPENCLAW_ROUTER_SLUG)).toBe(false);
  });

  it("throws on unknown logical id (no ad-hoc sanitize)", () => {
    expect(() => logicalIdToOpenClawSlug("/deft:unknown")).toThrow(/No OpenClaw slug/);
  });
});
