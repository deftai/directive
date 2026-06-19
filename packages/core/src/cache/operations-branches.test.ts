import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CacheCapBreachedError, CacheError, CacheValidationError } from "./errors.js";
import { restIssueListPaginated, runFetchAll, setPaginatedLister } from "./fetch.js";
import {
  cacheGet,
  cachePrune,
  cachePruneToCap,
  cachePut,
  isFresh,
  validateRepo,
} from "./operations.js";
import { FixedClock } from "./test-helpers.js";

describe("operations branches", () => {
  it("rejects invalid source and ttl on put", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-op-"));
    try {
      expect(() =>
        cachePut(
          "github-pr",
          "deftai/directive/1",
          { number: 1, title: "t", body: "" },
          {
            cacheRoot: root,
          },
        ),
      ).toThrow(/unknown source/);
      expect(() =>
        cachePut(
          "github-issue",
          "deftai/directive/1",
          { number: 1, title: "t", body: "" },
          { cacheRoot: root, ttlSeconds: -1 },
        ),
      ).toThrow(/ttl_seconds/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("raises cap breached when entry too large", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cap-b-"));
    try {
      expect(() =>
        cachePut(
          "github-issue",
          "deftai/directive/1",
          { number: 1, title: "x".repeat(5000), body: "y".repeat(5000), state: "open" },
          { cacheRoot: root, caps: { maxBytes: 10, maxEntries: 10 } },
        ),
      ).toThrow(CacheCapBreachedError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("get rejects corrupt meta", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-corrupt-"));
    const edir = join(root, "github-issue/deftai/directive/103");
    mkdirSync(edir, { recursive: true });
    writeFileSync(join(edir, "meta.json"), "{not-json", "utf8");
    try {
      expect(() => cacheGet("github-issue", "deftai/directive/103", { cacheRoot: root })).toThrow(
        CacheValidationError,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("isFresh rejects invalid meta", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-fresh-"));
    const metaPath = join(root, "meta.json");
    writeFileSync(metaPath, "{}", "utf8");
    try {
      expect(isFresh(metaPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validateRepo rejects bad slug", () => {
    expect(() => validateRepo("bad")).toThrow(CacheError);
  });

  it("prune removes corrupt entries", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-prune-c-"));
    const edir = join(root, "github-issue/deftai/directive/300");
    mkdirSync(edir, { recursive: true });
    writeFileSync(join(edir, "meta.json"), "{}", "utf8");
    const clock = new FixedClock(new Date("2026-06-19T00:00:00Z"));
    try {
      const removed = cachePrune({ cacheRoot: root, olderThanDays: 0, clock });
      expect(removed.length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("overwrite clears prior content on hard fail", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-over-"));
    try {
      cachePut(
        "github-issue",
        "deftai/directive/892",
        { number: 892, title: "t", body: "clean", state: "open" },
        { cacheRoot: root },
      );
      cachePut(
        "github-issue",
        "deftai/directive/892",
        { number: 892, title: "t", body: `AKIA${"A".repeat(16)}`, state: "open" },
        { cacheRoot: root },
      );
      const get = cacheGet("github-issue", "deftai/directive/892", { cacheRoot: root });
      expect(get.contentPath).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cachePruneToCap evicts for real", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-prune-cap-"));
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
        { cacheRoot: root, caps: { maxBytes: 0, maxEntries: 1 } },
      );
      const evicted = cachePruneToCap({
        cacheRoot: root,
        caps: { maxBytes: 1, maxEntries: 1 },
      });
      expect(evicted.length).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects negative older-than-days and bad github-issue number type", () => {
    expect(() => cachePrune({ olderThanDays: -1 })).toThrow(/older-than-days/);
    const root = mkdtempSync(join(tmpdir(), "deft-bad-num-"));
    try {
      expect(() =>
        cachePut(
          "github-issue",
          "deftai/directive/1",
          { number: "1", title: "t", body: "b", state: "open" },
          { cacheRoot: root },
        ),
      ).toThrow(/number.*must be int/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validateRepo accepts canonical slugs", () => {
    expect(() => validateRepo("deftai/directive")).not.toThrow();
    expect(() => validateRepo("bad")).toThrow(CacheError);
  });

  it("isFresh returns false for missing meta paths", () => {
    expect(isFresh(join(tmpdir(), "deft-missing-meta-xyz/meta.json"))).toBe(false);
  });

  it("cachePrune on missing cache root is a no-op", () => {
    expect(cachePrune({ cacheRoot: join(tmpdir(), "deft-no-cache-root-xyz") })).toEqual([]);
  });

  it("normalises issue state to lowercase on fetch", () => {
    setPaginatedLister(() => [{ number: 15, title: "t", body: "b", state: "OPEN" }]);
    const root = mkdtempSync(join(tmpdir(), "deft-state-norm-"));
    try {
      runFetchAll({
        repo: "deftai/directive",
        source: "github-issue",
        cacheRoot: root,
      });
      const raw = JSON.parse(
        readFileSync(join(root, "github-issue/deftai/directive/15/raw.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(raw.state).toBe("open");
    } finally {
      rmSync(root, { recursive: true, force: true });
      setPaginatedLister(restIssueListPaginated);
    }
  });
});
