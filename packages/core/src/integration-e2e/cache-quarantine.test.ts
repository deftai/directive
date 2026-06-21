import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cacheFetchAll, setPaginatedLister, setSleepFn } from "../cache/fetch.js";
import { cachePut } from "../cache/operations.js";
import { entryDir } from "../cache/paths.js";
import { validateMeta } from "../cache/validate.js";
import { GhRestError } from "../scm/gh-rest.js";
import { fakeIssue, makeTempRoot, REPO, readAuditRecords } from "./helpers.js";

const PREV_MAX_BYTES = process.env.DEFT_CACHE_MAX_BYTES;
const PREV_MAX_ENTRIES = process.env.DEFT_CACHE_MAX_ENTRIES;

afterEach(() => {
  if (PREV_MAX_BYTES === undefined) delete process.env.DEFT_CACHE_MAX_BYTES;
  else process.env.DEFT_CACHE_MAX_BYTES = PREV_MAX_BYTES;
  if (PREV_MAX_ENTRIES === undefined) delete process.env.DEFT_CACHE_MAX_ENTRIES;
  else process.env.DEFT_CACHE_MAX_ENTRIES = PREV_MAX_ENTRIES;
});

describe("integration-e2e cache quarantine (mirrors test_cache_quarantine.py)", () => {
  it("fetch-all rate limit recovers after Retry-After sleep", () => {
    const cacheRoot = makeTempRoot("deft-quarantine-rate-");
    let attempts = 0;
    const sleeps: number[] = [];

    setPaginatedLister(() => {
      attempts += 1;
      if (attempts === 1) {
        throw new GhRestError({
          stderr: "HTTP 429 too many requests\nRetry-After: 3\n",
          exitCode: 1,
          endpoint: "repos/deftai/directive/issues",
          payload: null,
          hint: "",
        });
      }
      return [fakeIssue(10, "Plain body.")];
    });
    setSleepFn((seconds) => {
      sleeps.push(seconds);
    });

    const report = cacheFetchAll({
      source: "github-issue",
      repo: REPO,
      batchSize: 10,
      delayMs: 0,
      cacheRoot,
    });

    expect(report.issuesWritten).toBe(1);
    expect(report.issuesFailed).toBe(0);
    expect(report.alreadyFresh).toBe(0);
    expect(sleeps).toContain(3);

    const edir = entryDir("github-issue", "deftai/directive/10", cacheRoot);
    expect(existsSync(join(edir, "raw.json"))).toBe(true);
    expect(existsSync(join(edir, "content.md"))).toBe(true);
    expect(existsSync(join(edir, "meta.json"))).toBe(true);
    validateMeta(JSON.parse(readFileSync(join(edir, "meta.json"), "utf8")));
  });

  it("fetch-all partial failure never aborts surviving entries", () => {
    const cacheRoot = makeTempRoot("deft-quarantine-partial-");
    setPaginatedLister(() => [
      fakeIssue(21),
      { ...fakeIssue(22), number: "not-an-int" },
      fakeIssue(23),
    ]);
    setSleepFn(() => {});

    const report = cacheFetchAll({
      source: "github-issue",
      repo: REPO,
      batchSize: 10,
      delayMs: 0,
      cacheRoot,
    });

    expect(report.issuesWritten).toBe(2);
    expect(report.issuesFailed).toBe(1);
    expect(report.alreadyFresh).toBe(0);
    const payload = JSON.parse(report.toJson()) as { succeeded: number; failed: number };
    expect(payload.succeeded).toBe(2);
    expect(payload.failed).toBe(1);

    for (const okNum of [21, 23]) {
      const edir = entryDir("github-issue", `deftai/directive/${okNum}`, cacheRoot);
      expect(existsSync(join(edir, "meta.json"))).toBe(true);
    }
    const failDir = entryDir("github-issue", "deftai/directive/22", cacheRoot);
    expect(existsSync(join(failDir, "meta.json"))).toBe(false);
  });

  it("cache put scan-failure skips content.md for credentials", () => {
    const cacheRoot = makeTempRoot("deft-quarantine-scan-");
    const token = `AKIA${"A".repeat(16)}`;
    const body = `## Issue summary\nSome context here.\n\nAccidentally posted token: ${token}\nEnd of body.\n`;
    const result = cachePut("github-issue", "deftai/directive/30", fakeIssue(30, body), {
      cacheRoot,
    });
    const edir = result.entryDir;
    expect(existsSync(join(edir, "raw.json"))).toBe(true);
    expect(existsSync(join(edir, "meta.json"))).toBe(true);
    expect(existsSync(join(edir, "content.md"))).toBe(false);

    const meta = JSON.parse(readFileSync(join(edir, "meta.json"), "utf8")) as {
      scan_result: { passed: boolean; flags: Array<{ category: string; detail: string }> };
    };
    validateMeta(meta);
    const cats = meta.scan_result.flags.map((f) => f.category);
    expect(cats).toContain("credentials");
    expect(meta.scan_result.passed).toBe(false);
    for (const flag of meta.scan_result.flags) {
      expect(flag.detail).not.toContain(token);
    }

    const audit = readAuditRecords(cacheRoot);
    expect(audit[0]?.event).toBe("cache:put");
    expect(audit[0]?.scan_passed).toBe(false);
    expect(audit[0]?.content_written).toBe(false);
  });

  it("fetch-all triggers eviction when entry cap exceeded", () => {
    const cacheRoot = makeTempRoot("deft-quarantine-evict-");
    process.env.DEFT_CACHE_MAX_BYTES = "0";
    process.env.DEFT_CACHE_MAX_ENTRIES = "2";

    setPaginatedLister(() => [40, 41, 42, 43].map((n) => fakeIssue(n)));
    setSleepFn(() => {});

    const report = cacheFetchAll({
      source: "github-issue",
      repo: REPO,
      batchSize: 10,
      delayMs: 0,
      cacheRoot,
    });
    expect(report.issuesWritten).toBe(4);
    expect(report.issuesFailed).toBe(0);

    for (const evicted of [40, 41]) {
      expect(existsSync(entryDir("github-issue", `deftai/directive/${evicted}`, cacheRoot))).toBe(
        false,
      );
    }
    for (const kept of [42, 43]) {
      const edir = entryDir("github-issue", `deftai/directive/${kept}`, cacheRoot);
      expect(existsSync(join(edir, "meta.json"))).toBe(true);
    }

    const evictRecords = readAuditRecords(cacheRoot).filter((r) => r.event === "cache:evict");
    expect(new Set(evictRecords.map((r) => r.key))).toEqual(
      new Set(["deftai/directive/40", "deftai/directive/41"]),
    );
    for (const record of evictRecords) {
      expect(record.trigger).toBe("cache:put");
      expect(record.reason).toBe("entry_cap");
    }
  });
});
