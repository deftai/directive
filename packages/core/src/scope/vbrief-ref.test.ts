import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectionContainmentError } from "../fs/projection-containment.js";
import {
  canonicalRelpath,
  collectChildUris,
  collectPlanRefs,
  rejectEscapingLifecycleRel,
  relativeToVbrief,
  resolveVbriefRef,
  scopeIdsForFilename,
} from "./vbrief-ref.js";

describe("vbrief-ref branches", () => {
  it("resolves and rejects uri forms", () => {
    const vbrief = mkdtempSync(join(tmpdir(), "vbrief-uri-"));
    mkdirSync(join(vbrief, "active"), { recursive: true });
    try {
      expect(resolveVbriefRef("file://active/x.xbrief.json", vbrief)).toContain("active");
      expect(resolveVbriefRef("https://example.com/x", vbrief)).toBeNull();
      expect(resolveVbriefRef("#anchor", vbrief)).toBeNull();
      expect(collectPlanRefs({ planRef: "", items: [{ planRef: "a" }, null] })).toEqual(["a"]);
      expect(collectChildUris({ references: [{ type: "x-vbrief/plan", uri: "" }] })).toEqual([]);
    } finally {
      rmSync(vbrief, { recursive: true, force: true });
    }
  });

  it("rejects escaping and absolute lifecycle refs (#2470)", () => {
    const vbrief = mkdtempSync(join(tmpdir(), "vbrief-ref-root-"));
    mkdirSync(join(vbrief, "active"), { recursive: true });
    try {
      expect(() => rejectEscapingLifecycleRel("../outside.xbrief.json")).toThrow(
        ProjectionContainmentError,
      );
      expect(() => rejectEscapingLifecycleRel(resolve("/outside/story.xbrief.json"))).toThrow(
        /absolute path/,
      );
      expect(() => resolveVbriefRef("../outside.xbrief.json", vbrief)).toThrow(
        /lifecycle ref refused/,
      );
      expect(() => resolveVbriefRef("active/../../outside.xbrief.json", vbrief)).toThrow(
        /parent traversal/,
      );
    } finally {
      rmSync(vbrief, { recursive: true, force: true });
    }
  });

  it("scopeIdsForFilename handles non-vbrief extensions", () => {
    expect(scopeIdsForFilename("slug.json").has("slug")).toBe(true);
    expect(scopeIdsForFilename("2026-01-01-my-scope.xbrief.json").has("my-scope")).toBe(true);
  });

  it("relative and canonical paths", () => {
    expect(relativeToVbrief("/outside", "/proj/vbrief")).toBeNull();
    expect(canonicalRelpath("/outside/x.xbrief.json", "/proj")).toBe(
      resolve("/outside/x.xbrief.json").replace(/\\/g, "/"),
    );
    expect(canonicalRelpath("/proj/xbrief/active/x.xbrief.json", "/proj")).toBe(
      "xbrief/active/x.xbrief.json",
    );
    expect(canonicalRelpath("/proj", "/proj")).toBe("");
    expect(relativeToVbrief("/proj/vbrief", "/proj/vbrief")).toBe("");
    expect(scopeIdsForFilename("2026-99-99-bad.xbrief.json").size).toBeGreaterThan(0);
  });
});
