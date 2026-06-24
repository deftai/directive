import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectRateLimit,
  FetchAllReportImpl,
  maybeSelfHealCache,
  probeCacheDrift,
  restIssueListPaginated,
  runFetchAll,
  StateRefreshReportImpl,
  setPaginatedLister,
  setSleepFn,
} from "./fetch.js";

describe("fetch-all", () => {
  it("detects rate limit stderr", () => {
    const [is429, retry] = detectRateLimit("HTTP 429\nRetry-After: 12\n");
    expect(is429).toBe(true);
    expect(retry).toBe(12);
  });

  it("runFetchAll uses paginated lister seam", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-fetch-"));
    const sleeps: number[] = [];
    setSleepFn((s) => sleeps.push(s));
    setPaginatedLister(() => [
      { number: 1, title: "t", body: "b", state: "open" },
      { number: 2, title: "t2", body: "b2", state: "open" },
    ]);
    try {
      const report = runFetchAll({
        repo: "deftai/directive",
        source: "github-issue",
        cacheRoot: root,
        delayMs: 0,
        batchSize: 1,
      });
      expect(report.issuesWritten).toBe(2);
      expect(report.issuesFailed).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      setPaginatedLister(restIssueListPaginated);
      setSleepFn(() => {});
    }
  });

  it("FetchAllReportImpl serialises legacy keys", () => {
    const report = new FetchAllReportImpl();
    report.issuesWritten = 1;
    report.alreadyFresh = 2;
    report.issuesFailed = 0;
    const json = JSON.parse(report.toJson()) as Record<string, unknown>;
    expect(json.succeeded).toBe(1);
    expect(json.skipped).toBe(2);
  });

  it("probeCacheDrift detects state and content drift", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-drift-"));
    const freshBase = join(root, "github-issue/deftai/directive/1");
    const staleBase = join(root, "github-issue/deftai/directive/2");
    mkdirSync(freshBase, { recursive: true });
    mkdirSync(staleBase, { recursive: true });
    writeFileSync(
      join(freshBase, "raw.json"),
      JSON.stringify({ number: 1, state: "open", title: "old", body: "b", labels: [] }),
      "utf8",
    );
    writeFileSync(
      join(freshBase, "meta.json"),
      JSON.stringify({ expires_at: "2099-01-01T00:00:00Z" }),
      "utf8",
    );
    writeFileSync(
      join(staleBase, "raw.json"),
      JSON.stringify({ number: 2, state: "open", title: "t", body: "b", labels: [] }),
      "utf8",
    );
    try {
      const drift = probeCacheDrift({
        repo: "deftai/directive",
        cacheRoot: root,
        listOpenFn: () => new Set([1]),
        fetchSingleFn: () => ({
          number: 1,
          state: "open",
          title: "new",
          body: "b",
          labels: [],
        }),
        isFreshFn: (metaPath) => metaPath.includes("/1/"),
      });
      expect(drift.stateDriftNumbers).toEqual([2]);
      expect(drift.contentDriftNumbers).toEqual([1]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("maybeSelfHealCache runs refresh when drift is present", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-heal-"));
    const base = join(root, ".deft-cache/github-issue/deftai/directive/3");
    mkdirSync(base, { recursive: true });
    writeFileSync(
      join(base, "raw.json"),
      JSON.stringify({ number: 3, state: "open", title: "t", body: "b" }),
      "utf8",
    );
    let refreshed = false;
    try {
      const result = maybeSelfHealCache(root, {
        repo: "deftai/directive",
        listOpenFn: () => new Set<number>(),
        refreshFn: () => {
          refreshed = true;
          return new StateRefreshReportImpl();
        },
      });
      expect(result.skipped).toBe(false);
      expect(refreshed).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("main CLI", () => {
  it("returns 2 for missing cmd", async () => {
    const { main } = await import("./main.js");
    expect(main([])).toBe(2);
  });

  it("returns 1 for invalid key on get path via put error", async () => {
    const { main } = await import("./main.js");
    expect(main(["get", "github-issue", "bad/key"])).toBe(1);
  });
});
