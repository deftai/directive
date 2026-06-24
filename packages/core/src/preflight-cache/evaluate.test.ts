import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CACHE_DIR_NAME, CANDIDATES_RELPATH, DEFAULT_SOURCE, evaluate } from "./evaluate.js";

/** Create a temp dir, return its path. Cleaned up in afterEach via tmpDirs. */
const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "preflight-cache-test-"));
  tmpDirs.push(dir);
  return dir;
}

function setupProjectRoot(): string {
  const root = makeTmpDir();
  // Create vbrief/.eval/ directory
  mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
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
    expect(result.message).toContain("cache:fetch-all --force");
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
    expect(result.message).toContain("cache:fetch-all --force");
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
    expect(result.message).toContain("cache:fetch-all --force");
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
});

describe("evaluate -- for-issue gate", () => {
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
      { issue: 42, repo: "owner/repo", decision: "defer", ts: new Date().toISOString() },
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
      { issue: 5, repo: "owner/repo", decision: "defer", ts: "2026-01-01T00:00:00Z" },
      { issue: 5, repo: "owner/repo", decision: "accept", ts: "2026-01-02T00:00:00Z" },
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
    const projectDef = join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json");
    writeFileSync(
      projectDef,
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
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
