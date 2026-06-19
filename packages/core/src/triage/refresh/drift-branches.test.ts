import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectDrift, isDrift, loadCachedFetchedAt } from "./drift.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "drift-br-"));
  roots.push(root);
  return root;
}

describe("loadCachedFetchedAt branches", () => {
  it("returns null for malformed repo keys and missing meta", () => {
    const root = makeRoot();
    expect(loadCachedFetchedAt("bad", 1, root)).toBeNull();
    expect(loadCachedFetchedAt("owner/repo", 1, root)).toBeNull();
  });

  it("reads fetched_at and ignores invalid meta payloads", () => {
    const root = makeRoot();
    const metaDir = join(root, ".deft-cache", "github-issue", "deftai", "directive", "42");
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(join(metaDir, "meta.json"), "not-json", "utf8");
    expect(loadCachedFetchedAt("deftai/directive", 42, root)).toBeNull();

    writeFileSync(
      join(metaDir, "meta.json"),
      JSON.stringify({ fetched_at: "2026-05-01T00:00:00Z" }),
      "utf8",
    );
    expect(loadCachedFetchedAt("deftai/directive", 42, root)).toBe("2026-05-01T00:00:00Z");
  });
});

describe("detectDrift branches", () => {
  it("skips duplicate refs and records fetch failures", () => {
    const root = makeRoot();
    const active = join(root, "vbrief", "active");
    mkdirSync(active, { recursive: true });
    writeFileSync(
      join(active, "a.vbrief.json"),
      JSON.stringify({
        plan: {
          references: [
            { type: "x-vbrief/github-issue", uri: "https://github.com/deftai/directive/issues/1" },
            { type: "x-vbrief/github-issue", uri: "https://github.com/deftai/directive/issues/1" },
          ],
        },
      }),
      "utf8",
    );
    const skipped: Array<[string, number, string]> = [];
    const checked: Array<[string, number]> = [];
    const logs: string[] = [];
    const drifts = detectDrift(active, root, {
      fetchLive: () => {
        throw new Error("offline");
      },
      cacheLoader: () => null,
      skippedOut: skipped,
      checkedOut: checked,
      log: (line) => logs.push(line),
    });
    expect(drifts).toEqual([]);
    expect(checked).toEqual([["deftai/directive", 1]]);
    expect(skipped[0]?.[2]).toContain("Error:");
    expect(logs[0]).toContain("WARN");
  });

  it("collects drift records when live is newer than cache", () => {
    const root = makeRoot();
    const active = join(root, "vbrief", "active");
    mkdirSync(active, { recursive: true });
    const vbrief = join(active, "b.vbrief.json");
    writeFileSync(
      vbrief,
      JSON.stringify({
        plan: {
          references: [
            { type: "x-vbrief/github-issue", uri: "https://github.com/deftai/directive/issues/9" },
          ],
        },
      }),
      "utf8",
    );
    const drifts = detectDrift(active, root, {
      fetchLive: () => "2026-05-05T00:00:00Z",
      cacheLoader: () => "2026-05-01T00:00:00Z",
    });
    expect(drifts).toHaveLength(1);
    expect(drifts[0]?.vbriefPath).toBe(vbrief);
    expect(isDrift("2026-05-01T00:00:00Z", "2026-05-05T00:00:00Z")).toBe(true);
  });
});
