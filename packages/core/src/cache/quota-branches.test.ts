import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cachePut } from "./operations.js";
import { enforceCaps, evictLru, predictEvictionSet, resolveCaps, scanUsage } from "./quota.js";

describe("quota branches", () => {
  const prevBytes = process.env.DEFT_CACHE_MAX_BYTES;
  const prevEntries = process.env.DEFT_CACHE_MAX_ENTRIES;

  afterEach(() => {
    if (prevBytes === undefined) delete process.env.DEFT_CACHE_MAX_BYTES;
    else process.env.DEFT_CACHE_MAX_BYTES = prevBytes;
    if (prevEntries === undefined) delete process.env.DEFT_CACHE_MAX_ENTRIES;
    else process.env.DEFT_CACHE_MAX_ENTRIES = prevEntries;
  });

  it("resolveCaps reads env and clamps negatives", () => {
    process.env.DEFT_CACHE_MAX_BYTES = "not-a-number";
    process.env.DEFT_CACHE_MAX_ENTRIES = "-5";
    expect(resolveCaps()).toEqual({ maxBytes: 0, maxEntries: 0 });
    expect(resolveCaps({ maxBytes: -1, maxEntries: -2 })).toEqual({
      maxBytes: 0,
      maxEntries: 0,
    });
  });

  it("scanUsage tolerates corrupt meta and missing mtime", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-quota-meta-"));
    const edir = join(root, "github-issue/deftai/directive/1");
    mkdirSync(edir, { recursive: true });
    writeFileSync(join(edir, "meta.json"), "not-json", "utf8");
    try {
      const usage = scanUsage(root);
      expect(usage.totalEntries).toBe(1);
      expect(usage.entries[0]?.metaPresent).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("evictLru respects protectKeys and entry_cap-only breach", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-quota-evict-"));
    try {
      cachePut(
        "github-issue",
        "deftai/directive/1",
        { number: 1, title: "a", body: "b", state: "open" },
        { cacheRoot: root },
      );
      cachePut(
        "github-issue",
        "deftai/directive/2",
        { number: 2, title: "c", body: "d", state: "open" },
        { cacheRoot: root },
      );
      const protectedEvict = evictLru(root, {
        caps: { maxBytes: 0, maxEntries: 1 },
        incomingBytes: 0,
        incomingEntries: 1,
        protectKeys: [["github-issue", "deftai/directive/1"]],
      });
      expect(protectedEvict.every((e) => e.key !== "deftai/directive/1")).toBe(true);

      const evicted = evictLru(root, {
        caps: { maxBytes: 999999, maxEntries: 1 },
        incomingBytes: 0,
        incomingEntries: 1,
        onEvict: () => {},
      });
      expect(evicted.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("predictEvictionSet and enforceCaps walk LRU victims", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-quota-predict-"));
    try {
      cachePut(
        "github-issue",
        "deftai/directive/10",
        { number: 10, title: "a", body: "b", state: "open" },
        { cacheRoot: root },
      );
      cachePut(
        "github-issue",
        "deftai/directive/11",
        { number: 11, title: "c", body: "d", state: "open" },
        { cacheRoot: root },
      );
      const caps = { maxBytes: 1, maxEntries: 1 };
      expect(predictEvictionSet(root, caps).length).toBeGreaterThan(0);
      const audit: string[] = [];
      const result = enforceCaps(root, {
        caps,
        onEvict: (victim, reason) => audit.push(`${victim.key}:${reason}`),
      });
      expect(result.evicted.length).toBeGreaterThan(0);
      expect(audit.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
