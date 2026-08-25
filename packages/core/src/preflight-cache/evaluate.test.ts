import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as emptyPopulate from "../cache/empty-populate.js";
import { writeOpenInventoryStamp } from "../cache/fetch.js";
import {
  CACHE_DIR_NAME,
  CANDIDATES_RELPATH,
  DEFAULT_SOURCE,
  evaluate,
  normaliseRepoUrl,
  recoveryHintForStaleFailure,
  shouldSkipDriftProbe,
} from "./evaluate.js";

/** Create a temp dir, return its path. Cleaned up in afterEach via tmpDirs. */
const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "preflight-cache-test-"));
  tmpDirs.push(dir);
  return dir;
}

function setupProjectRoot(): string {
  const root = makeTmpDir();
  // Create vbrief/.triage-cache/ directory
  mkdirSync(join(root, "xbrief", ".triage-cache"), { recursive: true });
  return root;
}

function writeCandidates(root: string, entries: object[]): void {
  const path = join(root, CANDIDATES_RELPATH);
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n"), "utf8");
}

function writeCacheEntry(
  root: string,
  repo: string,
  issueNum: number,
  fetchedAt: string,
  rawData: object = {},
): void {
  const [owner, name] = repo.split("/") as [string, string];
  const entryDir = join(root, CACHE_DIR_NAME, DEFAULT_SOURCE, owner, name, String(issueNum));
  mkdirSync(entryDir, { recursive: true });
  writeFileSync(join(entryDir, "meta.json"), JSON.stringify({ fetched_at: fetchedAt }), "utf8");
  writeFileSync(
    join(entryDir, "raw.json"),
    JSON.stringify({ number: issueNum, ...rawData }),
    "utf8",
  );
}

function writeOpenInventoryStampAt(root: string, repo: string, fetchedAt: string): void {
  writeOpenInventoryStamp({
    cacheRoot: join(root, CACHE_DIR_NAME),
    source: DEFAULT_SOURCE,
    repo,
    openCount: 0,
    fetchedAt: new Date(fetchedAt),
  });
}

function nowMinus(hours: number): Date {
  return new Date(Date.now() - hours * 3600 * 1000);
}

const noDriftProbe = () => ({
  stateDriftNumbers: [] as number[],
  contentDriftNumbers: [] as number[],
});

afterEach(() => {
  // Note: actual cleanup requires rmSync -- skip for fast tests (tmp is transient)
  tmpDirs.length = 0;
});

describe("evaluate -- missing cache", () => {
  it("returns code 2 when cache dir missing and allowMissingBootstrap=false", () => {
    const root = setupProjectRoot();
    const result = evaluate(root, { allowMissingBootstrap: false });
    expect(result.code).toBe(2);
    expect(result.message).toContain("❌");
  });

  it("returns code 0 when cache dir missing and allowMissingBootstrap=true", () => {
    const root = setupProjectRoot();
    const result = evaluate(root, { allowMissingBootstrap: true });
    expect(result.code).toBe(0);
    expect(result.message).toContain("bootstrap state");
  });

  it("returns code 0 when candidates log missing and allowMissingBootstrap=true", () => {
    const root = setupProjectRoot();
    // Create cache dir but no candidates
    mkdirSync(join(root, CACHE_DIR_NAME, DEFAULT_SOURCE), { recursive: true });
    const result = evaluate(root, { allowMissingBootstrap: true });
    expect(result.code).toBe(0);
    expect(result.message).toContain("bootstrap state");
  });

  it("returns code 2 when candidates log missing and allowMissingBootstrap=false", () => {
    const root = setupProjectRoot();
    mkdirSync(join(root, CACHE_DIR_NAME, DEFAULT_SOURCE), { recursive: true });
    const result = evaluate(root, { allowMissingBootstrap: false });
    expect(result.code).toBe(2);
  });
});

describe("evaluate -- terminal-closed entries (#1991)", () => {
  it("does not flag stale on an old CLOSED entry (--force can't refresh it)", () => {
    const root = setupProjectRoot();
    writeCandidates(root, [
      { issue: 1, repo: "owner/repo", decision: "accept", ts: new Date().toISOString() },
    ]);
    // Open entry fresh; closed entry old. Pre-#1991 the closed entry was the
    // oldest in-scope entry and wedged the gate with no working recovery.
    writeCacheEntry(root, "owner/repo", 1, nowMinus(1).toISOString(), { state: "open" });
    writeCacheEntry(root, "owner/repo", 1033, nowMinus(72).toISOString(), { state: "closed" });

    const result = evaluate(root, {
      allowMissingBootstrap: true,
      repo: "owner/repo",
      nowFn: () => new Date(),
      probeDriftFn: noDriftProbe,
    });
    expect(result.code).toBe(0);
    expect(result.message).toContain("✓");
  });

  it("treats an all-closed cache as fresh (nothing open to age out)", () => {
    const root = setupProjectRoot();
    writeCandidates(root, [
      { issue: 1033, repo: "owner/repo", decision: "accept", ts: new Date().toISOString() },
    ]);
    writeCacheEntry(root, "owner/repo", 1033, nowMinus(72).toISOString(), { state: "closed" });
    writeCacheEntry(root, "owner/repo", 1055, nowMinus(96).toISOString(), { state: "closed" });

    const result = evaluate(root, {
      allowMissingBootstrap: true,
      repo: "owner/repo",
      nowFn: () => new Date(),
      probeDriftFn: noDriftProbe,
    });
    expect(result.code).toBe(0);
  });

  it("still flags stale when an OPEN entry is old (closed exclusion is narrow)", () => {
    const root = setupProjectRoot();
    writeCandidates(root, [
      { issue: 2, repo: "owner/repo", decision: "accept", ts: new Date().toISOString() },
    ]);
    writeCacheEntry(root, "owner/repo", 1033, nowMinus(96).toISOString(), { state: "closed" });
    writeCacheEntry(root, "owner/repo", 2, nowMinus(25).toISOString(), { state: "open" });

    const result = evaluate(root, {
      allowMissingBootstrap: true,
      repo: "owner/repo",
      nowFn: () => new Date(),
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("25.0h old");
  });
});

describe("evaluate -- fresh cache", () => {
  it("returns code 0 for cache fetched 1h ago (within 24h)", () => {
    const root = setupProjectRoot();
    writeCandidates(root, [
      { issue: 1, repo: "owner/repo", decision: "accept", ts: new Date().toISOString() },
    ]);
    writeCacheEntry(root, "owner/repo", 1, nowMinus(1).toISOString());

    const result = evaluate(root, {
      allowMissingBootstrap: true,
      repo: "owner/repo",
      nowFn: () => new Date(),
      probeDriftFn: noDriftProbe,
    });
    expect(result.code).toBe(0);
    expect(result.message).toContain("✓");
  });

  it("returns code 1 for cache fetched 25h ago without running drift probe", () => {
    const root = setupProjectRoot();
    writeCandidates(root, [
      { issue: 1, repo: "owner/repo", decision: "accept", ts: new Date().toISOString() },
    ]);
    writeCacheEntry(root, "owner/repo", 1, nowMinus(25).toISOString());

    const result = evaluate(root, {
      allowMissingBootstrap: true,
      repo: "owner/repo",
      nowFn: () => new Date(),
      probeDriftFn: () => {
        throw new Error("drift probe should not run for age-stale cache");
      },
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("25.0h old");
  });

  it("returns code 1 for cache fetched 25h ago (stale)", () => {
    const root = setupProjectRoot();
    writeCandidates(root, [
      { issue: 1, repo: "owner/repo", decision: "accept", ts: new Date().toISOString() },
    ]);
    writeCacheEntry(root, "owner/repo", 1, nowMinus(25).toISOString());

    const result = evaluate(root, {
      allowMissingBootstrap: true,
      repo: "owner/repo",
      nowFn: () => new Date(),
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("❌");
    expect(result.message).toContain("25.0h old");
    expect(result.message).toContain("oldest in-scope entry");
    expect(result.message).toContain(
      "cache fetch-all --source github-issue --repo owner/repo --force",
    );
    expect(result.message).not.toContain("cache:fetch-all");
  });

  it("uses oldest in-scope entry age when newer entries exist", () => {
    const root = setupProjectRoot();
    writeCandidates(root, [
      { issue: 1, repo: "owner/repo", decision: "accept", ts: new Date().toISOString() },
      { issue: 2, repo: "owner/repo", decision: "accept", ts: new Date().toISOString() },
    ]);
    writeCacheEntry(root, "owner/repo", 1, nowMinus(30).toISOString());
    writeCacheEntry(root, "owner/repo", 2, nowMinus(1).toISOString());

    const result = evaluate(root, {
      allowMissingBootstrap: true,
      repo: "owner/repo",
      nowFn: () => new Date(),
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("30.0h old");
  });

  it("returns stale-by-drift when cached-open issues are absent upstream", () => {
    const root = setupProjectRoot();
    writeCandidates(root, [
      { issue: 7, repo: "owner/repo", decision: "accept", ts: new Date().toISOString() },
    ]);
    writeCacheEntry(root, "owner/repo", 7, nowMinus(1).toISOString(), { state: "open" });

    const result = evaluate(root, {
      allowMissingBootstrap: true,
      repo: "owner/repo",
      nowFn: () => new Date(),
      probeDriftFn: () => ({
        stateDriftNumbers: [7],
        contentDriftNumbers: [],
      }),
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("stale-by-drift");
    expect(result.message).toContain("cache fetch-all --source github-issue --repo owner/repo");
    expect(result.message).not.toContain("cache:fetch-all");
    expect(result.message).not.toContain("--force");
  });

  it("returns stale-by-drift for TTL-fresh content drift only", () => {
    const root = setupProjectRoot();
    writeCandidates(root, [
      { issue: 8, repo: "owner/repo", decision: "accept", ts: new Date().toISOString() },
    ]);
    writeCacheEntry(root, "owner/repo", 8, nowMinus(1).toISOString(), { state: "open" });

    const result = evaluate(root, {
      allowMissingBootstrap: true,
      repo: "owner/repo",
      nowFn: () => new Date(),
      probeDriftFn: () => ({
        stateDriftNumbers: [],
        contentDriftNumbers: [8],
      }),
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("TTL-fresh issue(s) with upstream content drift");
    expect(result.message).toContain("cache fetch-all --source github-issue --repo owner/repo");
    expect(result.message).not.toContain("cache:fetch-all");
    expect(result.message).not.toContain("--force");
  });

  it("fails open when the drift probe throws (#3738 / #3422)", () => {
    const root = setupProjectRoot();
    writeCandidates(root, [
      { issue: 9, repo: "owner/repo", decision: "accept", ts: new Date().toISOString() },
    ]);
    writeCacheEntry(root, "owner/repo", 9, nowMinus(1).toISOString(), { state: "open" });

    const result = evaluate(root, {
      allowMissingBootstrap: true,
      repo: "owner/repo",
      nowFn: () => new Date(),
      probeDriftFn: () => {
        throw new Error("forge unreachable");
      },
    });
    expect(result.code).toBe(0);
    expect(result.message).toContain("✓");
  });

  it("allows stale cache with drift when allowStale=true", () => {
    const root = setupProjectRoot();
    writeCandidates(root, [
      { issue: 1, repo: "owner/repo", decision: "accept", ts: new Date().toISOString() },
    ]);
    writeCacheEntry(root, "owner/repo", 1, nowMinus(48).toISOString());

    const result = evaluate(root, {
      allowMissingBootstrap: true,
      repo: "owner/repo",
      allowStale: true,
      nowFn: () => new Date(),
      probeDriftFn: () => ({
        stateDriftNumbers: [99],
        contentDriftNumbers: [],
      }),
    });
    expect(result.code).toBe(0);
    expect(result.message).toContain("⚠");
  });

  it("respects custom maxAgeHours", () => {
    const root = setupProjectRoot();
    writeCandidates(root, [
      { issue: 1, repo: "owner/repo", decision: "accept", ts: new Date().toISOString() },
    ]);
    writeCacheEntry(root, "owner/repo", 1, nowMinus(3).toISOString());

    // 2h limit -- 3h old should be stale
    const result = evaluate(root, {
      allowMissingBootstrap: true,
      repo: "owner/repo",
      maxAgeHours: 2,
      nowFn: () => new Date(),
    });
    expect(result.code).toBe(1);
  });

  it("allows stale cache when allowStale=true", () => {
    const root = setupProjectRoot();
    writeCandidates(root, [
      { issue: 1, repo: "owner/repo", decision: "accept", ts: new Date().toISOString() },
    ]);
    writeCacheEntry(root, "owner/repo", 1, nowMinus(48).toISOString());

    const result = evaluate(root, {
      allowMissingBootstrap: true,
      repo: "owner/repo",
      allowStale: true,
      nowFn: () => new Date(),
    });
    expect(result.code).toBe(0);
    expect(result.message).toContain("⚠");
  });

  it("allows stale cache when DEFT_RELEASE_PREFLIGHT is set (#2386)", () => {
    const root = setupProjectRoot();
    writeCandidates(root, [
      { issue: 1, repo: "owner/repo", decision: "accept", ts: new Date().toISOString() },
    ]);
    writeCacheEntry(root, "owner/repo", 1, nowMinus(48).toISOString());

    const prev = process.env.DEFT_RELEASE_PREFLIGHT;
    process.env.DEFT_RELEASE_PREFLIGHT = "1";
    try {
      const result = evaluate(root, {
        allowMissingBootstrap: true,
        repo: "owner/repo",
        nowFn: () => new Date(),
      });
      expect(result.code).toBe(0);
      expect(result.message).toContain("release pre-flight");
    } finally {
      if (prev === undefined) {
        delete process.env.DEFT_RELEASE_PREFLIGHT;
      } else {
        process.env.DEFT_RELEASE_PREFLIGHT = prev;
      }
    }
  });
});

describe("recoveryHintForStaleFailure -- branch-aware (#1953 / #2574)", () => {
  it("age-only failure names cache fetch-all --force", () => {
    const hint = recoveryHintForStaleFailure(
      { ageStale: true, driftDetected: false },
      "owner/repo",
    );
    expect(hint).toContain("cache fetch-all --source github-issue --repo owner/repo --force");
    expect(hint).not.toContain("cache:fetch-all");
  });

  it("drift-only failure names plain cache fetch-all", () => {
    const hint = recoveryHintForStaleFailure(
      { ageStale: false, driftDetected: true },
      "owner/repo",
    );
    expect(hint).toContain("cache fetch-all --source github-issue --repo owner/repo");
    expect(hint).not.toContain("--force");
    expect(hint).not.toContain("cache:fetch-all");
  });

  it("mixed age+drift prefers cache fetch-all --force", () => {
    const hint = recoveryHintForStaleFailure({ ageStale: true, driftDetected: true }, "owner/repo");
    expect(hint).toContain("cache fetch-all --source github-issue --repo owner/repo --force");
    expect(hint).not.toContain("cache:fetch-all");
  });
});

describe("evaluate -- skipDriftProbe (#3507)", () => {
  function freshAcceptCache(root: string, issue = 7): void {
    writeCandidates(root, [
      { issue, repo: "owner/repo", decision: "accept", ts: new Date().toISOString() },
    ]);
    writeCacheEntry(root, "owner/repo", issue, nowMinus(1).toISOString(), { state: "open" });
  }

  it("does not infer skip from a missing --for-issue", () => {
    expect(shouldSkipDriftProbe({})).toBe(false);
    expect(shouldSkipDriftProbe({ forIssue: null })).toBe(false);
    expect(shouldSkipDriftProbe({ skipDriftProbe: true, forIssue: 42 })).toBe(false);
    expect(shouldSkipDriftProbe({ skipDriftProbe: true })).toBe(true);
  });

  it("skips the live drift probe when skipDriftProbe is explicit", () => {
    const root = setupProjectRoot();
    freshAcceptCache(root);
    const probe = vi.fn(() => ({
      stateDriftNumbers: [7],
      contentDriftNumbers: [] as number[],
    }));

    const result = evaluate(root, {
      allowMissingBootstrap: true,
      repo: "owner/repo",
      skipDriftProbe: true,
      nowFn: () => new Date(),
      probeDriftFn: probe,
    });
    expect(result.code).toBe(0);
    expect(probe).not.toHaveBeenCalled();
    expect(result.message).toContain("Drift probe skipped (no work selection)");
    expect(result.message).not.toContain("stale-by-drift");
  });

  it("still fails closed on age staleness when the drift probe is skipped", () => {
    const root = setupProjectRoot();
    writeCandidates(root, [
      { issue: 1, repo: "owner/repo", decision: "accept", ts: new Date().toISOString() },
    ]);
    writeCacheEntry(root, "owner/repo", 1, nowMinus(48).toISOString());
    const probe = vi.fn(() => ({
      stateDriftNumbers: [99],
      contentDriftNumbers: [] as number[],
    }));

    const result = evaluate(root, {
      allowMissingBootstrap: true,
      repo: "owner/repo",
      skipDriftProbe: true,
      nowFn: () => new Date(),
      probeDriftFn: probe,
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("48.0h old");
    expect(result.message).not.toContain("stale-by-drift");
    expect(probe).not.toHaveBeenCalled();
  });

  it("re-arms the drift probe when --for-issue is present", () => {
    const root = setupProjectRoot();
    writeCandidates(root, [
      {
        decision_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        timestamp: "2026-06-29T12:00:00Z",
        repo: "owner/repo",
        issue_number: 7,
        decision: "accept",
        actor: "operator",
      },
    ]);
    writeCacheEntry(root, "owner/repo", 7, nowMinus(1).toISOString(), { state: "open" });
    const probe = vi.fn(() => ({
      stateDriftNumbers: [7],
      contentDriftNumbers: [] as number[],
    }));

    const result = evaluate(root, {
      allowMissingBootstrap: true,
      repo: "owner/repo",
      skipDriftProbe: true,
      forIssue: 7,
      nowFn: () => new Date(),
      probeDriftFn: probe,
    });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(result.code).toBe(1);
    expect(result.message).toContain("stale-by-drift");
  });
});

describe("evaluate -- for-issue gate", () => {
  it("returns code 0 when issue has accept decision (canonical audit schema only)", () => {
    const root = setupProjectRoot();
    writeCandidates(root, [
      {
        decision_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        timestamp: "2026-06-29T12:00:00Z",
        repo: "owner/repo",
        issue_number: 42,
        decision: "accept",
        actor: "operator",
      },
    ]);
    writeCacheEntry(root, "owner/repo", 42, nowMinus(1).toISOString());

    const result = evaluate(root, {
      allowMissingBootstrap: true,
      repo: "owner/repo",
      forIssue: 42,
      nowFn: () => new Date(),
      probeDriftFn: noDriftProbe,
    });
    expect(result.code).toBe(0);
    expect(result.message).toContain("accept");
  });

  it("returns code 0 when issue has accept decision", () => {
    const root = setupProjectRoot();
    writeCandidates(root, [
      {
        issue_number: 42,
        repo: "owner/repo",
        decision: "accept",
        timestamp: new Date().toISOString(),
      },
    ]);
    writeCacheEntry(root, "owner/repo", 42, nowMinus(1).toISOString());

    const result = evaluate(root, {
      allowMissingBootstrap: true,
      repo: "owner/repo",
      forIssue: 42,
      nowFn: () => new Date(),
      probeDriftFn: noDriftProbe,
    });
    expect(result.code).toBe(0);
    expect(result.message).toContain("accept");
  });

  it("returns code 1 when issue has defer decision", () => {
    const root = setupProjectRoot();
    writeCandidates(root, [
      {
        decision_id: "33333333-3333-4333-8333-333333333333",
        timestamp: new Date().toISOString(),
        repo: "owner/repo",
        issue_number: 42,
        decision: "defer",
        actor: "operator",
      },
    ]);
    writeCacheEntry(root, "owner/repo", 42, nowMinus(1).toISOString());

    const result = evaluate(root, {
      allowMissingBootstrap: true,
      repo: "owner/repo",
      forIssue: 42,
      nowFn: () => new Date(),
      probeDriftFn: noDriftProbe,
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("defer");
  });

  it("returns code 1 when issue has no triage decision", () => {
    const root = setupProjectRoot();
    writeCandidates(root, []);
    writeCacheEntry(root, "owner/repo", 99, nowMinus(1).toISOString());

    const result = evaluate(root, {
      allowMissingBootstrap: true,
      repo: "owner/repo",
      forIssue: 99,
      nowFn: () => new Date(),
      probeDriftFn: noDriftProbe,
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("no triage decision");
  });

  it("uses the LATEST decision when multiple entries exist", () => {
    const root = setupProjectRoot();
    writeCandidates(root, [
      {
        decision_id: "44444444-4444-4444-8444-444444444444",
        timestamp: "2026-01-01T00:00:00Z",
        repo: "owner/repo",
        issue_number: 5,
        decision: "defer",
        actor: "operator",
      },
      {
        decision_id: "55555555-5555-4555-8555-555555555555",
        timestamp: "2026-01-02T00:00:00Z",
        repo: "owner/repo",
        issue_number: 5,
        decision: "accept",
        actor: "operator",
      },
    ]);
    writeCacheEntry(root, "owner/repo", 5, nowMinus(1).toISOString());

    const result = evaluate(root, {
      allowMissingBootstrap: true,
      repo: "owner/repo",
      forIssue: 5,
      nowFn: () => new Date(),
      probeDriftFn: noDriftProbe,
    });
    expect(result.code).toBe(0);
  });
});

describe("evaluate -- audit log state messages", () => {
  it("reports 'fresh bootstrap' when candidates file is empty (0 bytes)", () => {
    const root = setupProjectRoot();
    writeCandidates(root, []);
    writeCacheEntry(root, "owner/repo", 1, nowMinus(1).toISOString());

    const result = evaluate(root, {
      repo: "owner/repo",
      allowMissingBootstrap: true,
      nowFn: () => new Date(),
      probeDriftFn: noDriftProbe,
    });
    expect(result.code).toBe(0);
    expect(result.message).toContain("fresh bootstrap");
  });

  it("reports 'actively triaging' when candidates file has entries", () => {
    const root = setupProjectRoot();
    writeCandidates(root, [
      { issue: 1, repo: "owner/repo", decision: "accept", ts: new Date().toISOString() },
    ]);
    writeCacheEntry(root, "owner/repo", 1, nowMinus(1).toISOString());

    const result = evaluate(root, {
      repo: "owner/repo",
      allowMissingBootstrap: true,
      nowFn: () => new Date(),
      probeDriftFn: noDriftProbe,
    });
    expect(result.code).toBe(0);
    expect(result.message).toContain("actively triaging");
  });
});

describe("evaluate -- correctness edge cases", () => {
  it("repoPattern in scope rule filters out non-matching repos", () => {
    const root = setupProjectRoot();
    writeCandidates(root, [
      { issue: 10, repo: "other/project", decision: "accept", ts: "2026-01-01T00:00:00Z" },
    ]);
    writeCacheEntry(root, "owner/repo", 10, nowMinus(1).toISOString(), {
      labels: [],
      repository: { full_name: "owner/repo" },
    });
    const projectDef = join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json");
    writeFileSync(
      projectDef,
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { policy: { triageScope: [{ repoPattern: "^owner/" }] } },
      }),
      "utf8",
    );

    const result = evaluate(root, {
      repo: "owner/repo",
      allowMissingBootstrap: true,
      nowFn: () => new Date(),
      probeDriftFn: noDriftProbe,
    });
    expect(result.code).toBe(0);
  });

  it("non-numeric DEFT_CACHE_MAX_AGE_HOURS falls back to default and does not disable staleness check", () => {
    const prevVal = process.env.DEFT_CACHE_MAX_AGE_HOURS;
    process.env.DEFT_CACHE_MAX_AGE_HOURS = "notanumber";
    try {
      const root = setupProjectRoot();
      writeCandidates(root, [
        { issue: 1, repo: "owner/repo", decision: "accept", ts: "2026-01-01T00:00:00Z" },
      ]);
      // Write a cache entry that is 200h old (exceeds any reasonable default)
      writeCacheEntry(root, "owner/repo", 1, nowMinus(200).toISOString());

      const result = evaluate(root, {
        repo: "owner/repo",
        allowMissingBootstrap: true,
        nowFn: () => new Date(),
      });
      // Should fail because cache is stale (200h > default ~24h), not silently pass due to NaN
      expect(result.code).toBe(1);
      expect(result.message).toContain("h old");
    } finally {
      if (prevVal === undefined) {
        delete process.env.DEFT_CACHE_MAX_AGE_HOURS;
      } else {
        process.env.DEFT_CACHE_MAX_AGE_HOURS = prevVal;
      }
    }
  });
});

describe("normaliseRepoUrl (CodeQL #51 host anchoring)", () => {
  it("parses valid github.com remotes across url forms", () => {
    expect(normaliseRepoUrl("https://github.com/deftai/directive")).toBe("deftai/directive");
    expect(normaliseRepoUrl("https://github.com/deftai/directive.git")).toBe("deftai/directive");
    expect(normaliseRepoUrl("git@github.com:deftai/directive.git")).toBe("deftai/directive");
    expect(normaliseRepoUrl("ssh://git@github.com/deftai/directive")).toBe("deftai/directive");
    expect(normaliseRepoUrl("github.com/deftai/directive")).toBe("deftai/directive");
  });

  it("rejects spoofed hosts where github.com is not the host component", () => {
    expect(normaliseRepoUrl("https://github.com.evil.com/deftai/directive")).toBeNull();
    expect(normaliseRepoUrl("https://evil.com/github.com/deftai/directive")).toBeNull();
    expect(normaliseRepoUrl("https://notgithub.com/deftai/directive")).toBeNull();
    expect(normaliseRepoUrl("https://evilgithub.com/deftai/directive")).toBeNull();
  });

  it("returns null on empty or malformed input", () => {
    expect(normaliseRepoUrl("")).toBeNull();
    expect(normaliseRepoUrl("https://github.com/only-owner")).toBeNull();
  });
});

describe("evaluate -- empty open inventory stamp (#2826)", () => {
  it("returns code 0 when cache is empty but open-inventory stamp is fresh", () => {
    const root = setupProjectRoot();
    writeCandidates(root, []);
    mkdirSync(join(root, CACHE_DIR_NAME, DEFAULT_SOURCE, "owner", "repo"), {
      recursive: true,
    });
    writeOpenInventoryStampAt(root, "owner/repo", nowMinus(1).toISOString());

    const result = evaluate(root, {
      allowMissingBootstrap: false,
      repo: "owner/repo",
      nowFn: () => new Date(),
      probeDriftFn: noDriftProbe,
    });
    expect(result.code).toBe(0);
    expect(result.message).toContain("✓");
    expect(result.message).not.toContain("Infinity");
  });

  it("returns code 1 when cache is empty with no open-inventory stamp (never fetched)", () => {
    const root = setupProjectRoot();
    writeCandidates(root, []);
    mkdirSync(join(root, CACHE_DIR_NAME, DEFAULT_SOURCE, "owner", "repo"), {
      recursive: true,
    });

    const result = evaluate(root, {
      allowMissingBootstrap: false,
      repo: "owner/repo",
      nowFn: () => new Date(),
      probeDriftFn: noDriftProbe,
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("Infinity");
  });

  it("returns code 1 when open-inventory stamp is stale", () => {
    const root = setupProjectRoot();
    writeCandidates(root, []);
    writeOpenInventoryStampAt(root, "owner/repo", nowMinus(48).toISOString());

    const result = evaluate(root, {
      allowMissingBootstrap: false,
      repo: "owner/repo",
      nowFn: () => new Date(),
      probeDriftFn: noDriftProbe,
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("48.0h old");
  });

  it("returns code 1 when open-inventory stamp has invalid fetched_at", () => {
    const root = setupProjectRoot();
    writeCandidates(root, []);
    const stampDir = join(root, CACHE_DIR_NAME, DEFAULT_SOURCE, "owner", "repo");
    mkdirSync(stampDir, { recursive: true });
    writeFileSync(
      join(stampDir, "open-inventory.json"),
      JSON.stringify({ fetched_at: "not-a-date", open_count: 0 }),
      "utf8",
    );

    const result = evaluate(root, {
      allowMissingBootstrap: false,
      repo: "owner/repo",
      nowFn: () => new Date(),
      probeDriftFn: noDriftProbe,
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("Infinity");
  });

  it("auto-populates empty cache with zero open issues then treats stamp as fresh", () => {
    const root = setupProjectRoot();
    writeCandidates(root, []);

    const populateSpy = vi
      .spyOn(emptyPopulate, "maybeAutoPopulateEmptyCache")
      .mockImplementation((projectRoot) => {
        writeOpenInventoryStampAt(projectRoot, "owner/repo", nowMinus(1).toISOString());
        return {
          skipped: false,
          skipReason: null,
          repo: "owner/repo",
          populated: true,
          succeeded: 0,
          message: "auto-populated empty triage cache from GitHub (owner/repo)",
        };
      });

    const result = evaluate(root, {
      allowMissingBootstrap: false,
      repo: "owner/repo",
      nowFn: () => new Date(),
      probeDriftFn: noDriftProbe,
    });

    expect(populateSpy).toHaveBeenCalled();
    expect(result.code).toBe(0);
    expect(result.message).toContain("✓");
    populateSpy.mockRestore();
  });
});

describe("evaluate -- empty cache auto-populate (#2575)", () => {
  it("auto-populates then returns fresh when cache was empty", () => {
    const root = setupProjectRoot();
    writeCandidates(root, []);

    const populateSpy = vi
      .spyOn(emptyPopulate, "maybeAutoPopulateEmptyCache")
      .mockImplementation((projectRoot) => {
        writeCacheEntry(projectRoot, "owner/repo", 99, nowMinus(1).toISOString(), {
          state: "open",
        });
        return {
          skipped: false,
          skipReason: null,
          repo: "owner/repo",
          populated: true,
          succeeded: 1,
          message: "ok",
        };
      });

    const result = evaluate(root, {
      allowMissingBootstrap: false,
      repo: "owner/repo",
      nowFn: () => new Date(),
      probeDriftFn: noDriftProbe,
    });

    expect(populateSpy).toHaveBeenCalled();
    expect(result.code).toBe(0);
    expect(result.message).toContain("✓");
    populateSpy.mockRestore();
  });

  it("does not auto-populate when allowMissingBootstrap is set", () => {
    const root = setupProjectRoot();
    const populateSpy = vi.spyOn(emptyPopulate, "maybeAutoPopulateEmptyCache");

    evaluate(root, { allowMissingBootstrap: true });
    expect(populateSpy).not.toHaveBeenCalled();
    populateSpy.mockRestore();
  });
});
