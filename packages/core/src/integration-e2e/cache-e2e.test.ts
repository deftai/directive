import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cacheFetchAll, setPaginatedLister, setSleepFn } from "../cache/fetch.js";
import { main as cacheMain } from "../cache/main.js";
import { CacheNotFoundError, cacheGet, cacheInvalidate } from "../cache/operations.js";
import { entryDir } from "../cache/paths.js";
import { SCANNER_VERSION } from "../cache/scanner.js";
import { validateMeta } from "../cache/validate.js";
import { fakeIssue, makeTempRoot, REPO, readAuditRecords } from "./helpers.js";

const FAKE_NUMBERS = [101, 102, 103, 104, 105] as const;

function wireFakeLister(numbers: readonly number[] = FAKE_NUMBERS): void {
  setPaginatedLister(() => numbers.map((n) => fakeIssue(n)));
  setSleepFn(() => {});
}

describe("integration-e2e cache (mirrors test_cache_e2e.py)", () => {
  it("fetch-all populates unified layout via cacheFetchAll", () => {
    const cacheRoot = makeTempRoot("deft-cache-e2e-");
    wireFakeLister();

    const report = cacheFetchAll({
      source: "github-issue",
      repo: REPO,
      batchSize: 10,
      delayMs: 0,
      cacheRoot,
    });
    expect(report.issuesWritten).toBe(FAKE_NUMBERS.length);
    expect(report.issuesFailed).toBe(0);
    expect(report.alreadyFresh).toBe(0);

    const base = join(cacheRoot, "github-issue", "deftai", "directive");
    expect(existsSync(base)).toBe(true);
    for (const n of FAKE_NUMBERS) {
      const edir = join(base, String(n));
      expect(existsSync(join(edir, "raw.json"))).toBe(true);
      expect(existsSync(join(edir, "content.md"))).toBe(true);
      expect(existsSync(join(edir, "meta.json"))).toBe(true);
      const raw = JSON.parse(readFileSync(join(edir, "raw.json"), "utf8")) as {
        number: number;
        html_url: string;
        state: string;
      };
      expect(raw.number).toBe(n);
      expect(raw.html_url.endsWith(`/${REPO}/issues/${n}`)).toBe(true);
      expect(raw.state).toBe("open");
    }
  });

  it("cache get returns meta envelope via TS module", () => {
    const cacheRoot = makeTempRoot("deft-cache-get-");
    wireFakeLister();
    cacheFetchAll({
      source: "github-issue",
      repo: REPO,
      batchSize: 10,
      delayMs: 0,
      cacheRoot,
    });

    const result = cacheGet("github-issue", `${REPO}/${FAKE_NUMBERS[0]}`, { cacheRoot });
    const meta = result.meta;
    validateMeta(meta);
    expect(meta.source).toBe("github-issue");
    expect(meta.key).toBe(`${REPO}/${FAKE_NUMBERS[0]}`);
    expect(String(meta.fetched_at).endsWith("Z")).toBe(true);
    expect(String(meta.expires_at).endsWith("Z")).toBe(true);
    expect(meta.stale).toBe(false);
    expect(result.stale).toBe(false);
    expect((meta.scan_result as { passed: boolean }).passed).toBe(true);
    expect((meta.scan_result as { scanner_version: string }).scanner_version).toBe(SCANNER_VERSION);
    expect(result.contentPath).not.toBeNull();
    expect(existsSync(result.contentPath as string)).toBe(true);
  });

  it("audit log records one cache:put per issue", () => {
    const cacheRoot = makeTempRoot("deft-cache-audit-");
    wireFakeLister();
    cacheFetchAll({
      source: "github-issue",
      repo: REPO,
      batchSize: 10,
      delayMs: 0,
      cacheRoot,
    });

    const records = readAuditRecords(cacheRoot);
    const putRecords = records.filter((r) => r.event === "cache:put");
    expect(putRecords).toHaveLength(FAKE_NUMBERS.length);
    expect(putRecords.map((r) => r.key).sort()).toEqual(
      FAKE_NUMBERS.map((n) => `${REPO}/${n}`).sort(),
    );
    expect(putRecords.every((r) => r.scan_passed === true)).toBe(true);
    expect(putRecords.every((r) => r.content_written === true)).toBe(true);
  });

  it("cache invalidate removes entry dir and appends audit records", () => {
    const cacheRoot = makeTempRoot("deft-cache-invalidate-");
    wireFakeLister();
    cacheFetchAll({
      source: "github-issue",
      repo: REPO,
      batchSize: 10,
      delayMs: 0,
      cacheRoot,
    });

    const targetKey = `${REPO}/${FAKE_NUMBERS[2]}`;
    const edir = entryDir("github-issue", targetKey, cacheRoot);
    expect(existsSync(edir)).toBe(true);

    expect(
      cacheInvalidate("github-issue", targetKey, {
        cacheRoot,
        reason: "story-4 e2e",
      }),
    ).toBe(true);
    expect(existsSync(edir)).toBe(false);
    expect(cacheInvalidate("github-issue", targetKey, { cacheRoot })).toBe(false);

    const invalidateRecords = readAuditRecords(cacheRoot).filter(
      (r) => r.event === "cache:invalidate",
    );
    expect(invalidateRecords).toHaveLength(2);
    expect(invalidateRecords[0]?.key).toBe(targetKey);
    expect(invalidateRecords[0]?.existed).toBe(true);
    expect(invalidateRecords[0]?.reason).toBe("story-4 e2e");
    expect(invalidateRecords[1]?.existed).toBe(false);

    expect(() => cacheGet("github-issue", targetKey, { cacheRoot })).toThrow(CacheNotFoundError);
  });

  it("second fetch-all skips fresh entries (idempotent)", () => {
    const cacheRoot = makeTempRoot("deft-cache-idempotent-");
    wireFakeLister();

    const first = cacheFetchAll({
      source: "github-issue",
      repo: REPO,
      batchSize: 10,
      delayMs: 0,
      cacheRoot,
    });
    expect(first.issuesWritten).toBe(FAKE_NUMBERS.length);
    expect(first.alreadyFresh).toBe(0);

    const putCountFirst = readAuditRecords(cacheRoot).filter((r) => r.event === "cache:put").length;
    expect(putCountFirst).toBe(FAKE_NUMBERS.length);

    const second = cacheFetchAll({
      source: "github-issue",
      repo: REPO,
      batchSize: 10,
      delayMs: 0,
      cacheRoot,
    });
    expect(second.issuesWritten).toBe(0);
    expect(second.issuesFailed).toBe(0);
    expect(second.alreadyFresh).toBe(FAKE_NUMBERS.length);

    const putCountSecond = readAuditRecords(cacheRoot).filter(
      (r) => r.event === "cache:put",
    ).length;
    expect(putCountSecond).toBe(putCountFirst);
  });

  it("cache CLI fetch-all round-trips via main()", () => {
    const cwd = makeTempRoot("deft-cache-cli-");
    const prevCwd = process.cwd();
    wireFakeLister();
    process.chdir(cwd);
    try {
      expect(
        cacheMain([
          "fetch-all",
          "--source",
          "github-issue",
          "--repo",
          REPO,
          "--batch-size",
          "10",
          "--delay-ms",
          "0",
        ]),
      ).toBe(0);
      expect(
        existsSync(
          join(cwd, ".deft-cache", "github-issue", "deftai", "directive", "101", "meta.json"),
        ),
      ).toBe(true);
    } finally {
      process.chdir(prevCwd);
    }
  });
});
