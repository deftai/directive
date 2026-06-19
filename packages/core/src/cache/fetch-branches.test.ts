import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GhRestError, InvalidRepoError, restIssueView } from "../scm/gh-rest.js";
import {
  cacheFetchAll,
  cacheRefreshClosed,
  detectRateLimit,
  listOpenIssueNumbers,
  restIssueListPaginated,
  runFetchAll,
  runStateRefresh,
  StateRefreshReportImpl,
  scanCachedOpenEntries,
  setPaginatedLister,
  setProgressWriter,
  setSingleIssueFetcher,
  setSleepFn,
} from "./fetch.js";

describe("fetch branches", () => {
  it("cacheFetchAll rejects bad source and delay", () => {
    expect(() => cacheFetchAll({ source: "other", repo: "a/b" })).toThrow(/not supported/);
    expect(() =>
      cacheFetchAll({ source: "github-issue", repo: "deftai/directive", delayMs: -1 }),
    ).toThrow(/delay-ms/);
  });

  it("handles invalid issue numbers in lister", () => {
    setPaginatedLister(() => [{ number: "bad", title: "t", body: "b", state: "open" }]);
    const root = mkdtempSync(join(tmpdir(), "deft-fetch2-"));
    try {
      const report = cacheFetchAll({
        source: "github-issue",
        repo: "deftai/directive",
        cacheRoot: root,
      });
      expect(report.issuesFailed).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
      setPaginatedLister(restIssueListPaginated);
    }
  });

  it("detectRateLimit negative path", () => {
    expect(detectRateLimit("404 not found")[0]).toBe(false);
    expect(detectRateLimit("")[0]).toBe(false);
  });

  it("scanCachedOpenEntries walks disk", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-scan-"));
    const base = join(root, "github-issue/deftai/directive/5");
    mkdirSync(base, { recursive: true });
    writeFileSync(
      join(base, "raw.json"),
      JSON.stringify({ number: 5, state: "open", title: "t", body: "b" }),
      "utf8",
    );
    try {
      expect(scanCachedOpenEntries("deftai/directive", "github-issue", root)).toHaveLength(1);
      expect(scanCachedOpenEntries("bad", "github-issue", root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runStateRefresh closes upstream", () => {
    const report = runStateRefresh({
      repo: "deftai/directive",
      openNumbers: new Set([1]),
      cachedOpen: [[2, { number: 2, state: "open" }]],
      doPut: () => {},
      fetchSingle: () => ({ number: 2, state: "closed", title: "t", body: "b" }),
    });
    expect(report.closedRewritten).toBe(1);
    const report2 = new StateRefreshReportImpl();
    expect(JSON.parse(report2.toJson()).revisited).toBe(0);
  });

  it("listOpenIssueNumbers via lister", () => {
    setPaginatedLister(() => [{ number: 3, state: "open" }]);
    try {
      expect(listOpenIssueNumbers("deftai/directive").has(3)).toBe(true);
    } finally {
      setPaginatedLister(restIssueListPaginated);
    }
  });

  it("skips already-fresh entries", () => {
    setPaginatedLister(() => [{ number: 4, title: "t", body: "b", state: "open" }]);
    const root = mkdtempSync(join(tmpdir(), "deft-fresh-skip-"));
    try {
      cacheFetchAll({
        source: "github-issue",
        repo: "deftai/directive",
        cacheRoot: root,
      });
      const report = cacheFetchAll({
        source: "github-issue",
        repo: "deftai/directive",
        cacheRoot: root,
      });
      expect(report.alreadyFresh).toBe(1);
      expect(report.issuesWritten).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      setPaginatedLister(restIssueListPaginated);
    }
  });

  it("cacheRefreshClosed rewrites closed issues", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-refresh-"));
    const base = join(root, "github-issue/deftai/directive/6");
    mkdirSync(base, { recursive: true });
    writeFileSync(
      join(base, "raw.json"),
      JSON.stringify({ number: 6, state: "open", title: "t", body: "b" }),
      "utf8",
    );
    setPaginatedLister(() => []);
    setSingleIssueFetcher(() => ({ number: 6, state: "closed", title: "t", body: "b" }));
    try {
      const report = cacheRefreshClosed({
        source: "github-issue",
        repo: "deftai/directive",
        cacheRoot: root,
      });
      expect(report.revisited).toBe(1);
      expect(report.closedRewritten).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
      setPaginatedLister(restIssueListPaginated);
      setSingleIssueFetcher(restIssueView);
    }
  });

  it("emits progress on large cohorts", () => {
    const lines: string[] = [];
    setProgressWriter((l) => lines.push(l));
    setPaginatedLister(() =>
      Array.from({ length: 50 }, (_, i) => ({
        number: i + 1,
        title: "t",
        body: "b",
        state: "open",
      })),
    );
    const root = mkdtempSync(join(tmpdir(), "deft-progress-"));
    try {
      runFetchAll({
        repo: "deftai/directive",
        source: "github-issue",
        cacheRoot: root,
        batchSize: 10,
        delayMs: 0,
      });
      expect(lines.some((l) => l.includes("progress"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      setPaginatedLister(restIssueListPaginated);
      setProgressWriter((l) => process.stderr.write(l));
    }
  });

  it("runStateRefresh handles fetch and rewrite failures", () => {
    const report = runStateRefresh({
      repo: "deftai/directive",
      openNumbers: new Set<number>(),
      cachedOpen: [[9, { number: 9, state: "open" }]],
      doPut: () => {
        throw new Error("rewrite fail");
      },
      fetchSingle: () => ({ number: 9, state: "closed", title: "t", body: "b" }),
    });
    expect(report.refreshFailed).toBe(1);
    const report2 = runStateRefresh({
      repo: "deftai/directive",
      openNumbers: new Set<number>(),
      cachedOpen: [[10, { number: 10, state: "open" }]],
      doPut: () => {},
      fetchSingle: () => {
        throw new Error("fetch fail");
      },
    });
    expect(report2.refreshFailed).toBe(1);
  });

  it("runStateRefresh counts still_open when live state is open", () => {
    const report = runStateRefresh({
      repo: "deftai/directive",
      openNumbers: new Set<number>(),
      cachedOpen: [[11, { number: 11, state: "open" }]],
      doPut: () => {},
      fetchSingle: () => ({ number: 11, state: "open", title: "t", body: "b" }),
    });
    expect(report.stillOpen).toBe(1);
  });

  it("scanCachedOpenEntries skips closed and corrupt raw", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-scan-skip-"));
    const openDir = join(root, "github-issue/deftai/directive/7");
    const closedDir = join(root, "github-issue/deftai/directive/8");
    const badDir = join(root, "github-issue/deftai/directive/9");
    mkdirSync(openDir, { recursive: true });
    mkdirSync(closedDir, { recursive: true });
    mkdirSync(badDir, { recursive: true });
    writeFileSync(
      join(openDir, "raw.json"),
      JSON.stringify({ number: 7, state: "open", title: "t", body: "b" }),
      "utf8",
    );
    writeFileSync(
      join(closedDir, "raw.json"),
      JSON.stringify({ number: 8, state: "closed", title: "t", body: "b" }),
      "utf8",
    );
    writeFileSync(join(badDir, "raw.json"), "{bad", "utf8");
    try {
      expect(scanCachedOpenEntries("deftai/directive", "github-issue", root)).toHaveLength(1);
      expect(scanCachedOpenEntries("deftai", "github-issue", root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restIssueListPaginated paginates via runGhApiFn", () => {
    let page = 0;
    const issues = restIssueListPaginated("deftai/directive", {
      runGhApiFn: () => {
        page += 1;
        if (page === 1) {
          return {
            returncode: 0,
            stdout: JSON.stringify([{ number: 1, title: "t", body: "b", state: "open" }]),
            stderr: "",
          };
        }
        return { returncode: 0, stdout: "[]", stderr: "" };
      },
      labels: ["bug"],
      author: "alice",
      limit: 1,
    });
    expect(issues).toHaveLength(1);
  });

  it("restIssueListPaginated rejects non-list payloads", () => {
    expect(() =>
      restIssueListPaginated("deftai/directive", {
        runGhApiFn: () => ({ returncode: 0, stdout: "{}", stderr: "" }),
      }),
    ).toThrow(/unexpected top-level type/);
  });

  it("cacheFetchAll maps InvalidRepoError to CacheFetchError", () => {
    setPaginatedLister(() => {
      throw new InvalidRepoError("bad repo");
    });
    try {
      expect(() => cacheFetchAll({ source: "github-issue", repo: "deftai/directive" })).toThrow(
        /invalid --repo/,
      );
    } finally {
      setPaginatedLister(restIssueListPaginated);
    }
  });

  it("cacheFetchAll fails after double rate limit", () => {
    setPaginatedLister(() => {
      throw new GhRestError({
        stderr: "HTTP 429 rate limit exceeded",
        exitCode: 0,
        endpoint: "repos/x/y/issues",
        payload: null,
      });
    });
    try {
      expect(() => cacheFetchAll({ source: "github-issue", repo: "deftai/directive" })).toThrow(
        /failed twice/,
      );
    } finally {
      setPaginatedLister(restIssueListPaginated);
    }
  });

  it("runFetchAll records doPut failures and ignores progress writer errors", () => {
    setProgressWriter(() => {
      throw new Error("progress sink broken");
    });
    setPaginatedLister(() => [{ number: 13, title: "t", body: "b", state: "open" }]);
    const root = mkdtempSync(join(tmpdir(), "deft-fetch-put-fail-"));
    try {
      const report = runFetchAll({
        repo: "deftai/directive",
        source: "github-issue",
        cacheRoot: root,
        doPut: () => {
          throw new Error("put failed");
        },
      });
      expect(report.issuesFailed).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
      setPaginatedLister(restIssueListPaginated);
      setProgressWriter((l) => process.stderr.write(l));
    }
  });

  it("detectRateLimit parses numeric Retry-After", () => {
    expect(detectRateLimit("HTTP 429 Retry-After: 30")[1]).toBe(30);
  });

  it("listIssuesRest maps non-429 GhRestError", () => {
    setPaginatedLister(() => {
      throw new GhRestError({
        stderr: "HTTP 500 internal error",
        exitCode: 1,
        endpoint: "repos/x/y/issues",
        payload: null,
      });
    });
    try {
      expect(() => cacheFetchAll({ source: "github-issue", repo: "deftai/directive" })).toThrow(
        /rest_issue_list_paginated failed/,
      );
    } finally {
      setPaginatedLister(restIssueListPaginated);
    }
  });

  it("restIssueListPaginated surfaces gh api failures", () => {
    expect(() =>
      restIssueListPaginated("deftai/directive", {
        runGhApiFn: () => ({ returncode: 1, stdout: "", stderr: "boom" }),
      }),
    ).toThrow(GhRestError);
  });

  it("listIssuesRest rethrows unknown errors", () => {
    setPaginatedLister(() => {
      throw new TypeError("unexpected lister failure");
    });
    try {
      expect(() => cacheFetchAll({ source: "github-issue", repo: "deftai/directive" })).toThrow(
        /unexpected lister failure/,
      );
    } finally {
      setPaginatedLister(restIssueListPaginated);
    }
  });

  it("restIssueListPaginated excludes pulls when requested", () => {
    const issues = restIssueListPaginated("deftai/directive", {
      excludePulls: false,
      runGhApiFn: () => ({
        returncode: 0,
        stdout: JSON.stringify([
          { number: 1, title: "t", body: "b", state: "open", pull_request: {} },
        ]),
        stderr: "",
      }),
    });
    expect(issues).toHaveLength(1);
  });

  it("runStateRefresh skips entries still in open enumeration", () => {
    const report = runStateRefresh({
      repo: "deftai/directive",
      openNumbers: new Set([5]),
      cachedOpen: [[5, { number: 5, state: "open" }]],
      doPut: () => {},
      fetchSingle: () => {
        throw new Error("should not fetch");
      },
    });
    expect(report.revisited).toBe(0);
  });

  it("runStateRefresh honors delayMs", () => {
    let slept = 0;
    setSleepFn((seconds) => {
      slept += seconds;
    });
    runStateRefresh({
      repo: "deftai/directive",
      openNumbers: new Set<number>(),
      cachedOpen: [[3, { number: 3, state: "open" }]],
      doPut: () => {},
      fetchSingle: () => ({ number: 3, state: "open", title: "t", body: "b" }),
      delayMs: 500,
    });
    expect(slept).toBeGreaterThan(0);
    setSleepFn(() => {});
  });

  it("restIssueListPaginated errors when pagination is unbounded", () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      number: i + 1,
      title: "t",
      body: "b",
      state: "open",
    }));
    expect(() =>
      restIssueListPaginated("deftai/directive", {
        runGhApiFn: () => ({
          returncode: 0,
          stdout: JSON.stringify(fullPage),
          stderr: "",
        }),
      }),
    ).toThrow(/REST_PAGINATION_MAX_PAGES/);
  });

  it("runFetchAll honors custom isFresh predicate", () => {
    setPaginatedLister(() => [{ number: 16, title: "t", body: "b", state: "open" }]);
    const root = mkdtempSync(join(tmpdir(), "deft-custom-fresh-"));
    try {
      const report = runFetchAll({
        repo: "deftai/directive",
        source: "github-issue",
        cacheRoot: root,
        isFresh: () => true,
      });
      expect(report.alreadyFresh).toBe(1);
      expect(report.issuesWritten).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      setPaginatedLister(restIssueListPaginated);
    }
  });

  it("runFetchAll handles empty issue lists", () => {
    setPaginatedLister(() => []);
    const root = mkdtempSync(join(tmpdir(), "deft-empty-list-"));
    try {
      const report = runFetchAll({
        repo: "deftai/directive",
        source: "github-issue",
        cacheRoot: root,
      });
      expect(report.issuesWritten).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      setPaginatedLister(restIssueListPaginated);
    }
  });

  it("runFetchAll records non-Error put failures", () => {
    setPaginatedLister(() => [{ number: 14, title: "t", body: "b", state: "open" }]);
    const root = mkdtempSync(join(tmpdir(), "deft-non-error-fail-"));
    try {
      const report = runFetchAll({
        repo: "deftai/directive",
        source: "github-issue",
        cacheRoot: root,
        doPut: () => {
          throw "string failure";
        },
      });
      expect(report.failures[0]?.reason).toBe("string failure");
    } finally {
      rmSync(root, { recursive: true, force: true });
      setPaginatedLister(restIssueListPaginated);
    }
  });
});
