import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cacheGet, cacheInvalidate, cachePrune, cachePut, isFresh } from "./operations.js";
import { FixedClock } from "./test-helpers.js";

function goodRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 883,
    title: "feat(cache): test entry",
    body: "clean issue body",
    state: "open",
    ...overrides,
  };
}

describe("cachePut / cacheGet TTL", () => {
  it("returns entry until TTL expires", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cache-"));
    const clock = new FixedClock(new Date("2026-06-19T12:00:00Z"));
    try {
      cachePut("github-issue", "deftai/directive/100", goodRaw({ number: 100 }), {
        cacheRoot: root,
        ttlSeconds: 60,
        clock,
        fetchedAt: clock.now(),
      });
      const hit = cacheGet("github-issue", "deftai/directive/100", { cacheRoot: root, clock });
      expect(hit.stale).toBe(false);
      expect(hit.contentPath).not.toBeNull();

      clock.advanceSeconds(61);
      const stale = cacheGet("github-issue", "deftai/directive/100", {
        cacheRoot: root,
        clock,
        allowStale: true,
      });
      expect(stale.stale).toBe(true);

      expect(() =>
        cacheGet("github-issue", "deftai/directive/100", {
          cacheRoot: root,
          clock,
          allowStale: false,
        }),
      ).toThrow(/stale/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("cacheInvalidate / cachePrune", () => {
  it("invalidate removes entry; prune drops expired", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cache-"));
    const clock = new FixedClock(new Date("2026-06-01T00:00:00Z"));
    try {
      cachePut("github-issue", "deftai/directive/200", goodRaw({ number: 200 }), {
        cacheRoot: root,
        ttlSeconds: 1,
        clock,
        fetchedAt: clock.now(),
      });
      expect(
        cacheInvalidate("github-issue", "deftai/directive/200", { cacheRoot: root, clock }),
      ).toBe(true);
      expect(existsSync(join(root, "github-issue/deftai/directive/200/meta.json"))).toBe(false);

      cachePut("github-issue", "deftai/directive/201", goodRaw({ number: 201 }), {
        cacheRoot: root,
        ttlSeconds: 1,
        clock,
        fetchedAt: new Date("2026-05-01T00:00:00Z"),
      });
      clock.setNow(new Date("2026-06-19T00:00:00Z"));
      const removed = cachePrune({ cacheRoot: root, olderThanDays: 30, clock });
      expect(removed.length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("quarantine hard-fail", () => {
  it("skips content.md for credentials", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cache-"));
    try {
      const result = cachePut(
        "github-issue",
        "deftai/directive/884",
        goodRaw({ number: 884, body: `oops: AKIA${"A".repeat(16)}` }),
        { cacheRoot: root },
      );
      expect(result.contentWritten).toBe(false);
      expect(existsSync(join(result.entryDir, "content.md"))).toBe(false);
      expect(result.scanResult.passed).toBe(false);
      const get = cacheGet("github-issue", "deftai/directive/884", { cacheRoot: root });
      expect(get.contentPath).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("isFresh", () => {
  it("returns false for missing meta", () => {
    expect(isFresh("/no/such/meta.json")).toBe(false);
  });
});

describe("audit log", () => {
  it("appends cache:put records", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cache-"));
    try {
      cachePut("github-issue", "deftai/directive/887", goodRaw({ number: 887 }), {
        cacheRoot: root,
      });
      const audit = readFileSync(join(root, "quarantine-audit.jsonl"), "utf8");
      expect(audit).toContain('"event":"cache:put"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
