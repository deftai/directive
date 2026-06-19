import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectDrift, loadCachedFetchedAt } from "./drift.js";

describe("loadCachedFetchedAt", () => {
  it("reads meta.json fetched_at", () => {
    const root = mkdtempSync(join(tmpdir(), "cache-meta-"));
    const metaDir = join(root, ".deft-cache", "github-issue", "deftai", "directive", "9");
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(
      join(metaDir, "meta.json"),
      JSON.stringify({ fetched_at: "2026-06-01T00:00:00Z" }),
      "utf8",
    );
    expect(loadCachedFetchedAt("deftai/directive", 9, root)).toBe("2026-06-01T00:00:00Z");
    rmSync(root, { recursive: true, force: true });
  });

  it("returns null for bad repo key or missing file", () => {
    const root = mkdtempSync(join(tmpdir(), "cache-bad-"));
    expect(loadCachedFetchedAt("bad", 1, root)).toBeNull();
    expect(loadCachedFetchedAt("deftai/directive", 1, root)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it("returns null for invalid meta json", () => {
    const root = mkdtempSync(join(tmpdir(), "cache-inv-"));
    const metaDir = join(root, ".deft-cache", "github-issue", "a", "b", "1");
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(join(metaDir, "meta.json"), "not-json", "utf8");
    expect(loadCachedFetchedAt("a/b", 1, root)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("detectDrift dedupe", () => {
  it("skips duplicate issue refs across vbriefs", () => {
    const root = mkdtempSync(join(tmpdir(), "drift-dedupe-"));
    const active = join(root, "vbrief", "active");
    mkdirSync(active, { recursive: true });
    const ref = {
      type: "x-vbrief/github-issue",
      uri: "https://github.com/deftai/directive/issues/1",
    };
    writeFileSync(
      join(active, "a.vbrief.json"),
      JSON.stringify({ plan: { references: [ref] } }),
      "utf8",
    );
    writeFileSync(
      join(active, "b.vbrief.json"),
      JSON.stringify({ plan: { references: [ref] } }),
      "utf8",
    );
    const checked: Array<[string, number]> = [];
    const drifts = detectDrift(active, root, {
      fetchLive: () => "2026-06-02T00:00:00Z",
      cacheLoader: () => "2026-06-01T00:00:00Z",
      checkedOut: checked,
    });
    expect(drifts).toHaveLength(1);
    expect(checked).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });
});
