import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countVbriefWip } from "../policy/wip.js";
import { expandReadinessPaths } from "../swarm/readiness.js";
import { matchesFilenameConvention, validateFilename } from "../vbrief-validate/filename.js";
import { discoverVbriefs } from "../vbrief-validate/validate-all.js";

const STORY = JSON.stringify({ plan: { id: "s", status: "running", items: [] } });

describe("layout-aware call sites accept the xbrief layout (#2109 part 1)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "layout-cs-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("readiness default glob resolves an xbrief/ tree", () => {
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(join(root, "xbrief", "active", "2026-06-30-x.xbrief.json"), STORY, "utf8");
    const paths = expandReadinessPaths(root, []);
    expect(paths.some((p) => p.endsWith("2026-06-30-x.xbrief.json"))).toBe(true);
  });

  it("readiness throws on a pure vbrief/ tree after the read-path removal (#2112)", () => {
    mkdirSync(join(root, "vbrief", "active"), { recursive: true });
    writeFileSync(join(root, "vbrief", "active", "2026-06-30-v.vbrief.json"), STORY, "utf8");
    expect(() => expandReadinessPaths(root, [])).toThrow(/deft migrate:xbrief/);
  });

  it("validate discovery picks up .xbrief.json artifacts", () => {
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(join(root, "xbrief", "active", "2026-06-30-x.xbrief.json"), STORY, "utf8");
    const found = discoverVbriefs(join(root, "xbrief"));
    expect(found.length).toBe(1);
    expect(found[0]?.display.endsWith("2026-06-30-x.xbrief.json")).toBe(true);
  });

  it("filename convention accepts both artifact suffixes", () => {
    expect(matchesFilenameConvention("2026-01-01-abc-def.vbrief.json")).toBe(true);
    expect(matchesFilenameConvention("2026-01-01-abc-def.xbrief.json")).toBe(true);
    expect(validateFilename("xbrief/PROJECT-DEFINITION.xbrief.json")).toEqual([]);
    expect(validateFilename("vbrief/PROJECT-DEFINITION.vbrief.json")).toEqual([]);
  });

  it("WIP count throws on a pure vbrief/ tree after the read-path removal (#2112)", () => {
    mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
    mkdirSync(join(root, "vbrief", "active"), { recursive: true });
    writeFileSync(join(root, "vbrief", "pending", "a.vbrief.json"), STORY, "utf8");
    writeFileSync(join(root, "vbrief", "active", "b.vbrief.json"), STORY, "utf8");
    expect(() => countVbriefWip(root)).toThrow(/deft migrate:xbrief/);
  });

  it("WIP count resolves pending+active under a migrated xbrief/ tree", () => {
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(join(root, "xbrief", "pending", "a.xbrief.json"), STORY, "utf8");
    writeFileSync(join(root, "xbrief", "active", "b.xbrief.json"), STORY, "utf8");
    writeFileSync(join(root, "xbrief", "active", "c.xbrief.json"), STORY, "utf8");
    expect(countVbriefWip(root)).toBe(3);
  });
});
