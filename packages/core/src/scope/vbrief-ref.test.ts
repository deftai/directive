import { describe, expect, it } from "vitest";
import {
  canonicalRelpath,
  collectChildUris,
  collectPlanRefs,
  relativeToVbrief,
  resolveVbriefRef,
  scopeIdsForFilename,
} from "./vbrief-ref.js";

describe("vbrief-ref branches", () => {
  it("resolves and rejects uri forms", () => {
    const vbrief = "/proj/vbrief";
    expect(resolveVbriefRef("file://active/x.vbrief.json", vbrief)).toContain("active");
    expect(resolveVbriefRef("https://example.com/x", vbrief)).toBeNull();
    expect(resolveVbriefRef("#anchor", vbrief)).toBeNull();
    expect(collectPlanRefs({ planRef: "", items: [{ planRef: "a" }, null] })).toEqual(["a"]);
    expect(collectChildUris({ references: [{ type: "x-vbrief/plan", uri: "" }] })).toEqual([]);
  });

  it("scopeIdsForFilename handles non-vbrief extensions", () => {
    expect(scopeIdsForFilename("slug.json").has("slug")).toBe(true);
    expect(scopeIdsForFilename("2026-01-01-my-scope.vbrief.json").has("my-scope")).toBe(true);
  });

  it("relative and canonical paths", () => {
    expect(relativeToVbrief("/outside", "/proj/vbrief")).toBeNull();
    expect(canonicalRelpath("/outside/x.vbrief.json", "/proj")).toBe("/outside/x.vbrief.json");
    expect(canonicalRelpath("/proj/vbrief/active/x.vbrief.json", "/proj")).toBe(
      "vbrief/active/x.vbrief.json",
    );
    expect(canonicalRelpath("/proj", "/proj")).toBe("");
    expect(relativeToVbrief("/proj/vbrief", "/proj/vbrief")).toBe("");
    expect(scopeIdsForFilename("2026-99-99-bad.vbrief.json").size).toBeGreaterThan(0);
  });
});
