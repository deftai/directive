import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureTriageCacheHydrated,
  isTriageCacheEmpty,
  maybeAutoPopulateEmptyCache,
} from "./empty-populate.js";

const tmpDirs: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "empty-populate-"));
  tmpDirs.push(root);
  mkdirSync(join(root, "xbrief", ".triage-cache"), { recursive: true });
  return root;
}

function writeCacheEntry(root: string, repo: string, issueNum: number): void {
  const [owner, name] = repo.split("/") as [string, string];
  const entryDir = join(root, ".deft-cache", "github-issue", owner, name, String(issueNum));
  mkdirSync(entryDir, { recursive: true });
  writeFileSync(
    join(entryDir, "meta.json"),
    JSON.stringify({ fetched_at: new Date().toISOString() }),
    "utf8",
  );
  writeFileSync(
    join(entryDir, "raw.json"),
    JSON.stringify({ number: issueNum, state: "open" }),
    "utf8",
  );
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

describe("isTriageCacheEmpty", () => {
  it("returns true when cache dir is absent", () => {
    const root = makeRoot();
    expect(isTriageCacheEmpty(root)).toBe(true);
  });

  it("returns false when cached issues exist", () => {
    const root = makeRoot();
    writeCacheEntry(root, "owner/repo", 1);
    expect(isTriageCacheEmpty(root)).toBe(false);
  });
});

describe("maybeAutoPopulateEmptyCache", () => {
  it("skips when cache is non-empty", () => {
    const root = makeRoot();
    writeCacheEntry(root, "owner/repo", 42);
    const fetchFn = vi.fn();
    const result = maybeAutoPopulateEmptyCache(root, {
      repo: "owner/repo",
      fetchFn,
    });
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("cache-non-empty");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("skips when repo cannot be resolved", () => {
    const root = makeRoot();
    const result = maybeAutoPopulateEmptyCache(root, {
      inferRepoFn: () => null,
    });
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("repo-not-resolved");
  });

  it("populates empty cache via fetch-all and seeds audit log", () => {
    const root = makeRoot();
    const fetchFn = vi.fn(() => ({
      issuesWritten: 3,
      alreadyFresh: 0,
      issuesFailed: 0,
      failures: [],
      toJson: () => "{}",
      summaryLine: () => "ok",
    }));
    const seedFn = vi.fn(() => ({
      ok: true,
      name: "seed",
      message: "seeded",
      details: {},
      error: null,
    }));
    const backfillFn = vi.fn(() => ({
      ok: true,
      name: "backfill",
      message: "backfilled",
      details: {},
      error: null,
    }));

    const result = maybeAutoPopulateEmptyCache(root, {
      repo: "deftai/directive",
      fetchFn: fetchFn as never,
      seedFn: seedFn as never,
      backfillFn: backfillFn as never,
    });

    expect(result.populated).toBe(true);
    expect(result.succeeded).toBe(3);
    expect(fetchFn).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: "deftai/directive",
        force: true,
      }),
    );
    expect(seedFn).toHaveBeenCalled();
    expect(backfillFn).toHaveBeenCalledWith(root, "deftai/directive");
  });

  it("returns skip when backfill throws", () => {
    const root = makeRoot();
    const fetchFn = vi.fn(() => ({
      issuesWritten: 2,
      alreadyFresh: 0,
      issuesFailed: 0,
      failures: [],
      toJson: () => "{}",
      summaryLine: () => "ok",
    }));
    const seedFn = vi.fn(() => ({
      ok: true,
      name: "seed",
      message: "seeded",
      details: {},
      error: null,
    }));
    const backfillFn = vi.fn(() => {
      throw new Error("permission denied");
    });

    const result = maybeAutoPopulateEmptyCache(root, {
      repo: "deftai/directive",
      fetchFn: fetchFn as never,
      seedFn: seedFn as never,
      backfillFn: backfillFn as never,
    });

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("backfill-failed");
    expect(result.message).toContain("permission denied");
  });

  it("ensureTriageCacheHydrated delegates to maybeAutoPopulateEmptyCache", () => {
    const root = makeRoot();
    const result = ensureTriageCacheHydrated(root, {
      inferRepoFn: () => null,
    });
    expect(result.skipReason).toBe("repo-not-resolved");
  });
});
