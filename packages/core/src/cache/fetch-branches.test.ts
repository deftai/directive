import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GhRestError, InvalidRepoError, restIssueView } from "../scm/gh-rest.js";
import { CURRENT_SHAPE_SIDECAR, RAW_ISSUE_COMMENTS_KEY } from "../umbrella-current-shape/index.js";
import {
  cacheFetchAll,
  cacheRefreshClosed,
  detectRateLimit,
  enrichRawWithCommentsIfUmbrella,
  listOpenIssueNumbers,
  readOpenInventoryStamp,
  restIssueListPaginated,
  runFetchAll,
  runStateRefresh,
  StateRefreshReportImpl,
  scanCachedOpenEntries,
  setPaginatedLister,
  setProgressWriter,
  setSingleIssueFetcher,
  setSleepFn,
  writeOpenInventoryStamp,
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
      expect(
        existsSync(join(root, "github-issue", "deftai", "directive", "open-inventory.json")),
      ).toBe(true);
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

  it("runFetchAll --force rewrites TTL-fresh entries", () => {
    setPaginatedLister(() => [{ number: 17, title: "t", body: "b", state: "open" }]);
    const root = mkdtempSync(join(tmpdir(), "deft-force-rewrite-"));
    try {
      cacheFetchAll({
        source: "github-issue",
        repo: "deftai/directive",
        cacheRoot: root,
      });
      const withoutForce = cacheFetchAll({
        source: "github-issue",
        repo: "deftai/directive",
        cacheRoot: root,
      });
      expect(withoutForce.alreadyFresh).toBe(1);
      expect(withoutForce.issuesWritten).toBe(0);

      const withForce = cacheFetchAll({
        source: "github-issue",
        repo: "deftai/directive",
        cacheRoot: root,
        force: true,
      });
      expect(withForce.alreadyFresh).toBe(0);
      expect(withForce.issuesWritten).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
      setPaginatedLister(restIssueListPaginated);
    }
  });

  it("runFetchAll rewrites TTL-fresh entries flagged by content drift", () => {
    setPaginatedLister(() => [{ number: 18, title: "live", body: "b", state: "open", labels: [] }]);
    const root = mkdtempSync(join(tmpdir(), "deft-drift-rewrite-"));
    try {
      cacheFetchAll({
        source: "github-issue",
        repo: "deftai/directive",
        cacheRoot: root,
      });
      const rawPath = join(root, "github-issue/deftai/directive/18/raw.json");
      writeFileSync(
        rawPath,
        JSON.stringify({ number: 18, state: "open", title: "cached", body: "b", labels: [] }),
        "utf8",
      );

      const report = cacheFetchAll({
        source: "github-issue",
        repo: "deftai/directive",
        cacheRoot: root,
        contentDriftNumbers: [18],
      });
      expect(report.alreadyFresh).toBe(0);
      expect(report.issuesWritten).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
      setPaginatedLister(restIssueListPaginated);
    }
  });

  it("runFetchAll skips TTL-fresh non-drifted entries by default", () => {
    setPaginatedLister(() => [{ number: 19, title: "t", body: "b", state: "open" }]);
    const root = mkdtempSync(join(tmpdir(), "deft-default-skip-"));
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
        contentDriftNumbers: [],
      });
      expect(report.alreadyFresh).toBe(1);
      expect(report.issuesWritten).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      setPaginatedLister(restIssueListPaginated);
    }
  });

  it("enrichRawWithCommentsIfUmbrella attaches comments only for tracker-like issues (#1870)", () => {
    const shapeBody = "## Current shape (as of pass-1)\n\nLast updated: now\n";
    const comments = [
      {
        id: 1,
        body: shapeBody,
        html_url: "https://github.com/o/r/issues/1#issuecomment-1",
        author_association: "MEMBER",
        user: { login: "m" },
      },
    ];
    const fetchComments = () => comments;
    const umbrella = enrichRawWithCommentsIfUmbrella(
      "o/r",
      { number: 1, labels: [{ name: "epic" }], body: "charter" },
      { fetchComments },
    );
    expect(umbrella[RAW_ISSUE_COMMENTS_KEY]).toEqual(comments);
    const plain = enrichRawWithCommentsIfUmbrella(
      "o/r",
      { number: 2, labels: [{ name: "bug" }], body: "fix" },
      { fetchComments },
    );
    expect(plain[RAW_ISSUE_COMMENTS_KEY]).toBeUndefined();
  });

  it("cacheFetchAll persists current-shape into content.md for epic issues (#1870)", () => {
    const shapeBody =
      "## Current shape (as of pass-2)\n\n" +
      "Last updated: 2026-06-28T12:00:00Z\n" +
      "Last pass type: additive\n" +
      "Child count: 1 (1/0)\n" +
      "Child-count history: pass-1: 1, pass-2: 1\n\n" +
      "### Open children\n\n- c\n\n### Closed children\n\n(none)\n\n" +
      "### Wave order\n\n- Wave 1\n\n### Reading order for fresh contributors\n\n1. Body\n";
    setPaginatedLister(() => [
      {
        number: 1669,
        title: "Umbrella",
        body: "stale charter",
        state: "open",
        labels: [{ name: "epic" }],
      },
    ]);
    const root = mkdtempSync(join(tmpdir(), "deft-fetch-shape-"));
    try {
      const report = cacheFetchAll({
        source: "github-issue",
        repo: "deftai/directive",
        cacheRoot: root,
        fetchComments: () => [
          {
            id: 88,
            body: shapeBody,
            html_url: "https://github.com/deftai/directive/issues/1669#issuecomment-88",
            author_association: "MEMBER",
            user: { login: "maint" },
          },
        ],
      });
      expect(report.issuesWritten).toBe(1);
      const edir = join(root, "github-issue/deftai/directive/1669");
      const content = readFileSync(join(edir, "content.md"), "utf8");
      expect(content).toContain("Canonical current shape");
      expect(content).toContain("stale charter");
      expect(content).toContain("pass-2");
      expect(existsSync(join(edir, CURRENT_SHAPE_SIDECAR))).toBe(true);
      const raw = JSON.parse(readFileSync(join(edir, "raw.json"), "utf8")) as Record<
        string,
        unknown
      >;
      expect(Array.isArray(raw[RAW_ISSUE_COMMENTS_KEY])).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      setPaginatedLister(restIssueListPaginated);
    }
  });
});

describe("open inventory stamp (#2826)", () => {
  it("readOpenInventoryStamp returns null for absent or invalid stamps", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-open-inv-read-"));
    try {
      expect(readOpenInventoryStamp(root, "github-issue", "deftai/directive")).toBeNull();

      const stampDir = join(root, "github-issue", "deftai", "directive");
      mkdirSync(stampDir, { recursive: true });
      writeFileSync(join(stampDir, "open-inventory.json"), "not-json", "utf8");
      expect(readOpenInventoryStamp(root, "github-issue", "deftai/directive")).toBeNull();

      writeFileSync(
        join(stampDir, "open-inventory.json"),
        JSON.stringify({ fetched_at: "2026-01-01T00:00:00Z", open_count: 3 }),
        "utf8",
      );
      expect(readOpenInventoryStamp(root, "github-issue", "deftai/directive")).toBeNull();

      writeFileSync(
        join(stampDir, "open-inventory.json"),
        JSON.stringify({ open_count: 0 }),
        "utf8",
      );
      expect(readOpenInventoryStamp(root, "github-issue", "deftai/directive")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writeOpenInventoryStamp no-ops when openCount is not zero", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-open-inv-write-skip-"));
    try {
      writeOpenInventoryStamp({
        cacheRoot: root,
        source: "github-issue",
        repo: "deftai/directive",
        openCount: 2,
      });
      expect(
        existsSync(join(root, "github-issue", "deftai", "directive", "open-inventory.json")),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writeOpenInventoryStamp and readOpenInventoryStamp round-trip", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-open-inv-roundtrip-"));
    try {
      writeOpenInventoryStamp({
        cacheRoot: root,
        source: "github-issue",
        repo: "deftai/directive",
        openCount: 0,
        fetchedAt: new Date("2026-07-24T12:00:00Z"),
      });
      expect(readOpenInventoryStamp(root, "github-issue", "deftai/directive")).toEqual({
        fetched_at: "2026-07-24T12:00:00Z",
        open_count: 0,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
