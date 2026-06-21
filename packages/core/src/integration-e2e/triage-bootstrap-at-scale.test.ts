import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cacheFetchAll, setPaginatedLister, setSleepFn } from "../cache/fetch.js";
import { runBootstrap, runWithTimeout, stepPopulateCache } from "../triage/bootstrap/index.js";
import type { FetchAllReport } from "../triage/bootstrap/types.js";
import { bootstrapCacheModule } from "./bootstrap-cache-module.js";
import { fakeIssue, makeTempRoot, REPO, SCALE_ISSUE_COUNT } from "./helpers.js";

function wireScaleFixture(): void {
  const numbers = Array.from({ length: SCALE_ISSUE_COUNT }, (_, i) => i + 1);
  setPaginatedLister(() => numbers.map((n) => fakeIssue(n)));
  setSleepFn(() => {});
}

describe("integration-e2e triage bootstrap at scale (mirrors test_triage_bootstrap_at_scale.py)", () => {
  it("runBootstrap completes at backlog scale without wall-clock sleep", async () => {
    const root = makeTempRoot("deft-bootstrap-scale-");
    wireScaleFixture();

    const result = await runBootstrap(root, REPO, {
      batchSize: 10,
      delayMs: 0,
      fetchTimeoutS: 30,
      progress: null,
      cacheModule: bootstrapCacheModule(cacheFetchAll),
    });

    expect(result.exitCode).toBe(0);
    expect(result.steps).toHaveLength(5);
    expect(result.steps.every((step) => step.ok)).toBe(true);
    const populate = result.steps[0];
    expect(populate?.details.succeeded).toBe(SCALE_ISSUE_COUNT);
    expect(populate?.details.failed).toBe(0);
    expect(populate?.details.skipped).toBe(0);

    const base = join(root, ".deft-cache", "github-issue", "deftai", "directive");
    expect(existsSync(base)).toBe(true);
    const cached = readdirSync(base)
      .filter((name) => /^\d+$/.test(name))
      .map((name) => Number.parseInt(name, 10))
      .sort((a, b) => a - b);
    expect(cached).toEqual(Array.from({ length: SCALE_ISSUE_COUNT }, (_, i) => i + 1));

    const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
    expect(gitignore).toContain(".deft-cache/");
    expect(gitignore).toContain("vbrief/.eval/candidates.jsonl");
    expect(gitignore).toContain("vbrief/.eval/summary-history.jsonl");
    expect(gitignore).toContain("vbrief/.eval/scope-lifecycle.jsonl");
    const activeLines = gitignore
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    expect(activeLines).not.toContain("vbrief/.eval/");
  });

  it("runBootstrap emits per-step progress lines", async () => {
    const root = makeTempRoot("deft-bootstrap-progress-");
    wireScaleFixture();
    const lines: string[] = [];

    const result = await runBootstrap(root, REPO, {
      batchSize: 10,
      delayMs: 0,
      fetchTimeoutS: 30,
      progress: (line) => {
        lines.push(line);
      },
      cacheModule: bootstrapCacheModule(cacheFetchAll),
    });
    expect(result.exitCode).toBe(0);

    for (const stem of [
      "triage:bootstrap step 1/5 populate_cache -- starting",
      "triage:bootstrap step 1/5 populate_cache -- done",
      "triage:bootstrap step 2/5 backfill_audit_log -- starting",
      "triage:bootstrap step 2/5 backfill_audit_log -- done",
      "triage:bootstrap step 3/5 ensure_gitignore_entry -- starting",
      "triage:bootstrap step 3/5 ensure_gitignore_entry -- done",
      "triage:bootstrap step 4/5 ensure_gitignore_eval_entries -- starting",
      "triage:bootstrap step 4/5 ensure_gitignore_eval_entries -- done",
      "triage:bootstrap step 5/5 seed_candidates_log -- starting",
      "triage:bootstrap step 5/5 seed_candidates_log -- done",
    ]) {
      expect(lines.some((line) => line.startsWith(stem))).toBe(true);
    }
  });

  it("stepPopulateCache watchdog fires on hung fetch using fake timers", async () => {
    vi.useFakeTimers();
    const root = makeTempRoot("deft-bootstrap-watchdog-");
    const pending = stepPopulateCache(root, REPO, {
      cacheModule: {
        cacheFetchAll: () => new Promise<FetchAllReport>(() => {}),
      },
      fetchTimeoutS: 0.5,
      runWithTimeoutFn: runWithTimeout,
    });
    await vi.advanceTimersByTimeAsync(600);
    const outcome = await pending;
    vi.useRealTimers();

    expect(outcome.ok).toBe(false);
    expect(outcome.details.timed_out).toBe(true);
    expect(outcome.details.fetch_timeout_s).toBe(0.5);
    expect(outcome.error).toContain("fetch_timeout_s=0.5");
  });

  it("runBootstrap emits timeout progress and structured exit on hung fetch", async () => {
    vi.useFakeTimers();
    const root = makeTempRoot("deft-bootstrap-watchdog-e2e-");
    const lines: string[] = [];
    const pending = runBootstrap(root, REPO, {
      fetchTimeoutS: 0.5,
      progress: (line) => lines.push(line),
      cacheModule: {
        cacheFetchAll: () => new Promise<FetchAllReport>(() => {}),
      },
      runWithTimeoutFn: runWithTimeout,
    });
    await vi.advanceTimersByTimeAsync(600);
    const result = await pending;
    vi.useRealTimers();

    expect(result.exitCode).toBe(1);
    const populate = result.steps[0];
    expect(populate?.ok).toBe(false);
    expect(populate?.details.timed_out).toBe(true);
    expect(
      lines.some((line) => line.startsWith("triage:bootstrap step 1/5 populate_cache -- starting")),
    ).toBe(true);
    expect(
      lines.some((line) => line.startsWith("triage:bootstrap step 1/5 populate_cache -- timeout")),
    ).toBe(true);
    expect(result.steps[2]?.ok).toBe(true);
    expect(result.steps[3]?.ok).toBe(true);
  });

  it("runWithTimeout surfaces silent worker termination as ok=false", async () => {
    const root = makeTempRoot("deft-bootstrap-thread-death-");
    const outcome = await stepPopulateCache(root, REPO, {
      cacheModule: {
        cacheFetchAll: async () => {
          throw new Error("simulated nested failure inside fetch_all");
        },
      },
      fetchTimeoutS: 5,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.details.failed).toBe("fetch-all-error");
    expect(outcome.details.timed_out).toBeUndefined();
  });

  it("fetch_timeout_s=0 disables watchdog and completes against hermetic fixture", async () => {
    const root = makeTempRoot("deft-bootstrap-no-watchdog-");
    wireScaleFixture();
    const outcome = await stepPopulateCache(root, REPO, {
      batchSize: 10,
      delayMs: 0,
      fetchTimeoutS: 0,
      cacheModule: bootstrapCacheModule(cacheFetchAll),
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.details.timed_out).toBeUndefined();
    expect(outcome.details.succeeded).toBe(SCALE_ISSUE_COUNT);
    expect(outcome.details.fetch_timeout_s).toBe(0);
  });
});
