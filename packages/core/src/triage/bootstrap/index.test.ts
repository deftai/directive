import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FETCH_TIMEOUT_S,
  defaultFetchTimeoutFromEnv,
  formatJson,
  formatSummary,
  inferRepoFromGit,
  normaliseLabelFilter,
  runBootstrap,
  runWithTimeout,
  stepBackfillAuditLog,
  stepPopulateCache,
} from "./index.js";
import type { CacheModule, FetchAllReport } from "./types.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-bootstrap-"));
  temps.push(root);
  return root;
}

function buildFakeCache(report: Partial<FetchAllReport> = {}): CacheModule & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    cacheFetchAll(kwargs) {
      calls.push(kwargs);
      return {
        succeeded: 5,
        failed: 0,
        skipped: 0,
        ...report,
      };
    },
  };
}

function writeScopeVbrief(root: string, folder: string, slug: string, issue: number): void {
  const dir = join(root, "vbrief", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${slug}.vbrief.json`),
    JSON.stringify({
      vBRIEFInfo: { version: "0.6" },
      plan: {
        id: slug,
        title: slug,
        status: "proposed",
        references: [
          {
            type: "x-vbrief/github-issue",
            uri: `https://github.com/deftai/directive/issues/${issue}`,
          },
        ],
      },
    }),
    "utf8",
  );
}

describe("normaliseLabelFilter", () => {
  it("flattens comma-separated and repeated labels", () => {
    expect(normaliseLabelFilter(["bug,p0", "docs"])).toEqual(["bug", "p0", "docs"]);
  });
});

describe("runWithTimeout", () => {
  it("returns timeout when func exceeds cap", async () => {
    vi.useFakeTimers();
    const pending = runWithTimeout(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("late"), 5000);
        }),
      1,
    );
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result.completed).toBe(false);
    vi.useRealTimers();
  });

  it("captures exceptions from the worker", async () => {
    const result = await runWithTimeout(() => {
      throw new Error("worker failed");
    }, 5);
    expect(result.completed).toBe(true);
    expect(result.error?.message).toBe("worker failed");
  });
});

describe("stepPopulateCache", () => {
  it("invokes cache_fetch_all with expected kwargs", async () => {
    const root = makeRoot();
    const cache = buildFakeCache({ succeeded: 10, skipped: 2 });
    const outcome = await stepPopulateCache(root, "deftai/directive", { cacheModule: cache });
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain("deftai/directive");
    expect(cache.calls).toHaveLength(1);
    const kwargs = cache.calls[0] as Record<string, unknown>;
    expect(kwargs.source).toBe("github-issue");
    expect(kwargs.repo).toBe("deftai/directive");
    expect(kwargs.cacheRoot).toBe(join(root, ".deft-cache"));
    expect(kwargs.delayMs).toBeUndefined();
  });

  it("skips when no repo", async () => {
    const root = makeRoot();
    const outcome = await stepPopulateCache(root, null, { cacheModule: buildFakeCache() });
    expect(outcome.ok).toBe(true);
    expect(outcome.details.skipped).toBe("no-repo");
  });

  it("stepPopulateCache watchdog triggers on slow async cacheFetchAll", async () => {
    const root = makeRoot();
    const cache: CacheModule = {
      cacheFetchAll: () =>
        new Promise<FetchAllReport>((resolvePromise) => {
          setTimeout(() => resolvePromise({ succeeded: 0, failed: 0, skipped: 0 }), 5000);
        }),
    };
    const started = performance.now();
    const outcome = await stepPopulateCache(root, "deftai/directive", {
      cacheModule: cache,
      fetchTimeoutS: 0.05,
    });
    const elapsed = performance.now() - started;
    expect(outcome.ok).toBe(false);
    expect(outcome.details.timed_out).toBe(true);
    expect(outcome.message).toContain("0.05s");
    expect(outcome.message).not.toContain("0.05g");
    expect(elapsed).toBeLessThan(2000);
  });

  it("rejects invalid repo slug", async () => {
    const root = makeRoot();
    const outcome = await stepPopulateCache(root, "bad", { cacheModule: buildFakeCache() });
    expect(outcome.ok).toBe(false);
  });

  it("uses legacy message when summaryLine throws", async () => {
    const root = makeRoot();
    const cache: CacheModule = {
      cacheFetchAll() {
        return {
          succeeded: 1,
          failed: 0,
          skipped: 0,
          summaryLine: () => {
            throw new Error("boom");
          },
        };
      },
    };
    const outcome = await stepPopulateCache(root, "deftai/directive", { cacheModule: cache });
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain("succeeded=1");
  });

  it("defers when cache module missing", async () => {
    const root = makeRoot();
    const outcome = await stepPopulateCache(root, "deftai/directive", { deftRoot: root });
    expect(outcome.ok).toBe(true);
    expect(outcome.details.deferred).toBe("cache-module-missing");
  });
});

describe("stepBackfillAuditLog", () => {
  it("skips when no repo", () => {
    const root = makeRoot();
    expect(stepBackfillAuditLog(root, null).details.skipped).toBe("no-repo");
  });

  it("skips when vbrief directory missing", () => {
    const root = makeRoot();
    expect(stepBackfillAuditLog(root, "deftai/directive").details.skipped).toBe("no-vbrief");
  });

  it("writes one accept entry per scope vbrief", () => {
    const root = makeRoot();
    writeScopeVbrief(root, "proposed", "story-a", 100);
    writeScopeVbrief(root, "pending", "story-b", 101);
    writeScopeVbrief(root, "active", "story-c", 102);
    writeScopeVbrief(root, "cancelled", "story-d", 103);

    const outcome = stepBackfillAuditLog(root, "deftai/directive", {
      nowIso: () => "2026-06-18T12:00:00Z",
    });
    expect(outcome.ok).toBe(true);
    const audit = join(root, "vbrief", ".eval", "candidates.jsonl");
    const lines = readFileSync(audit, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { issue_number: number; decision: string; actor: string });
    expect(lines).toHaveLength(3);
    expect(lines.map((e) => e.issue_number).sort((a, b) => a - b)).toEqual([100, 101, 102]);
    expect(lines.every((e) => e.decision === "accept")).toBe(true);
    expect(lines.every((e) => e.actor === "agent:bootstrap")).toBe(true);
  });
});

describe("runBootstrap", () => {
  it("runs five steps in order", async () => {
    const root = makeRoot();
    const cache = buildFakeCache();
    const result = await runBootstrap(root, "deftai/directive", {
      cacheModule: cache,
      progress: null,
    });
    expect(result.steps).toHaveLength(5);
    expect(result.steps.map((s) => s.name)).toEqual([
      "populate_cache",
      "backfill_audit_log",
      "ensure_gitignore_entry",
      "ensure_gitignore_eval_entries",
      "seed_candidates_log",
    ]);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "vbrief", ".eval", "candidates.jsonl"), "utf8")).toBe("");
  });

  it("threads inferred repo to backfill (#1237)", async () => {
    const root = makeRoot();
    writeScopeVbrief(root, "proposed", "story-a", 100);
    const cache = buildFakeCache();
    const result = await runBootstrap(root, null, {
      cacheModule: cache,
      progress: null,
      inferRepoFromGit: () => "deftai/directive",
    });
    const backfill = result.steps.find((s) => s.name === "backfill_audit_log");
    expect(backfill?.details.skipped).not.toBe("no-repo");
    expect(backfill?.details.appended).toBeGreaterThanOrEqual(1);
  });
});

describe("formatJson", () => {
  it("sorts keys like Python sort_keys=True", async () => {
    const root = makeRoot();
    const result = await runBootstrap(root, null, {
      cacheModule: buildFakeCache(),
      progress: null,
      inferRepoFromGit: () => null,
    });
    const json = formatJson(result);
    expect(json).toContain('"exit_code": 0');
    expect(json.indexOf('"details"')).toBeLessThan(json.indexOf('"error"'));
  });
});

describe("formatSummary", () => {
  it("includes next steps on success", async () => {
    const root = makeRoot();
    const result = await runBootstrap(root, null, {
      cacheModule: buildFakeCache(),
      progress: null,
      inferRepoFromGit: () => null,
    });
    const summary = formatSummary(result);
    expect(summary).toContain("Triage v1 bootstrap recap:");
    expect(summary).toContain("Next steps:");
    expect(summary).toContain("task triage:accept");
  });

  it("omits next steps when a step failed", async () => {
    const root = makeRoot();
    const result = await runBootstrap(root, "bad-slug", {
      cacheModule: buildFakeCache(),
      progress: null,
    });
    expect(result.exitCode).toBe(1);
    expect(formatSummary(result)).not.toContain("Next steps:");
  });
});

describe("defaultFetchTimeoutFromEnv", () => {
  it("falls back when env is unparseable", () => {
    const prior = process.env.DEFT_BOOTSTRAP_FETCH_TIMEOUT_S;
    process.env.DEFT_BOOTSTRAP_FETCH_TIMEOUT_S = "not-a-number";
    expect(defaultFetchTimeoutFromEnv()).toBe(DEFAULT_FETCH_TIMEOUT_S);
    if (prior === undefined) delete process.env.DEFT_BOOTSTRAP_FETCH_TIMEOUT_S;
    else process.env.DEFT_BOOTSTRAP_FETCH_TIMEOUT_S = prior;
  });
});

describe("inferRepoFromGit", () => {
  it("returns null when git is unavailable", () => {
    expect(inferRepoFromGit("/tmp/does-not-exist-no-git-repo-here")).toBeNull();
  });
});
