import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cachePut } from "./operations.js";
import { type CacheCaps, enforceCaps, evictLru, resolveCaps, scanUsage } from "./quota.js";

describe("quota", () => {
  it("evicts LRU when over entry cap", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cache-cap-"));
    const caps: CacheCaps = { maxBytes: 0, maxEntries: 1 };
    try {
      cachePut(
        "github-issue",
        "deftai/directive/1",
        { number: 1, title: "a", body: "" },
        {
          cacheRoot: root,
          caps,
        },
      );
      cachePut(
        "github-issue",
        "deftai/directive/2",
        { number: 2, title: "b", body: "" },
        {
          cacheRoot: root,
          caps,
        },
      );
      const usage = scanUsage(root);
      expect(usage.totalEntries).toBeLessThanOrEqual(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolveCaps reads env defaults", () => {
    const caps = resolveCaps();
    expect(caps.maxBytes).toBeGreaterThan(0);
    expect(caps.maxEntries).toBeGreaterThan(0);
  });

  it("resolveCaps treats invalid env as disabled", () => {
    const prev = process.env.DEFT_CACHE_MAX_BYTES;
    process.env.DEFT_CACHE_MAX_BYTES = "not-a-number";
    try {
      expect(resolveCaps().maxBytes).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.DEFT_CACHE_MAX_BYTES;
      else process.env.DEFT_CACHE_MAX_BYTES = prev;
    }
  });

  it("enforceCaps dry-run path via predict", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cap-"));
    try {
      const result = enforceCaps(root, { caps: { maxBytes: 1, maxEntries: 1 } });
      expect(result.evicted).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("evictLru returns empty when caps disabled", () => {
    expect(evictLru("/tmp", { caps: { maxBytes: 0, maxEntries: 0 } })).toEqual([]);
  });
});
