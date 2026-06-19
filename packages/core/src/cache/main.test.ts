import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectRateLimit,
  FetchAllReportImpl,
  restIssueListPaginated,
  runFetchAll,
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
