#!/usr/bin/env node
/**
 * Resolve the authoritative CI lane result for a required aggregator job
 * (#2672 / #3168 / #3340).
 *
 * Env:
 *   REPO, RUN_ID, GH_TOKEN (via gh), WANT_FAILOVER, FAILOVER_RESULT,
 *   PRIMARY_NEEDLE (lowercase substring of primary job name), SUITE_LABEL
 *   QUEUE_PASSED, QUEUE_RUN_ID, QUEUE_RUN_ATTEMPT (optional, #6584): when
 *   QUEUE_PASSED=true with an id and attempt, exit 0 citing that queue run and
 *   make no API read.
 *   OBSERVATION_BUDGET_MINUTES (optional, #7014): polling budget counted from
 *   resolver start; unset keeps the 6-hour deadline. Each `gh api` call has a
 *   subprocess timeout and transient failures (HTTP 5xx, call timeout) are
 *   retried with backoff inside the deadline.
 *
 * When WANT_FAILOVER=true, the GH-hosted failover job result is authoritative.
 * When WANT_FAILOVER=false, the Blacksmith primary is polled until completed.
 * Primary/failover lane job names are never branch-protection required names —
 * only the aggregator job names in ci.yml are.
 */

import { execFileSync } from "node:child_process";

/** Deadline when no observation budget is set (the TypeScript aggregator). */
const DEFAULT_OBSERVATION_DEADLINE_MS = 6 * 60 * 60 * 1000;

/**
 * Per `gh api` call subprocess timeout (#7014). A hung call must not outlive the
 * deadline by more than one call; well above a normal sub-second jobs read.
 */
const GH_API_CALL_TIMEOUT_MS = 60_000;

/** Retries after the first failed `gh api` call on HTTP 5xx or call timeout (#7014). */
const GH_API_MAX_RETRIES = 4;

/** First backoff before a retry; doubles each retry (2s, 4s, 8s, 16s) (#7014). */
const GH_API_RETRY_BASE_MS = 2_000;

/**
 * @param {Record<string, unknown> | null | undefined} job
 * @returns {boolean}
 */
export function runnerClaimed(job) {
  if (job == null) return false;
  const runner = job.runner_name;
  if (runner == null) return false;
  return Boolean(String(runner).trim());
}

/**
 * Prefer the reusable-workflow inner `/run` job over the caller wrapper (#3340).
 * @param {string} needle
 * @param {Record<string, unknown>} payload
 * @returns {Record<string, unknown> | null}
 */
export function selectPrimaryJob(needle, payload) {
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
  const matches = jobs.filter((job) => String(job?.name ?? "").toLowerCase().includes(needle));
  if (matches.length === 0) return null;
  const inner = matches.filter((job) => String(job?.name ?? "").includes(" / "));
  const pool = inner.length > 0 ? inner : matches;
  const claimed = pool.filter((job) => runnerClaimed(job));
  if (claimed.length > 0) return claimed[0];
  const completed = pool.filter((job) => String(job?.status ?? "") === "completed");
  if (completed.length > 0) return completed[0];
  return pool[0];
}

/**
 * Cancelled/skipped without a runner_name is capacity death (#3168 / #3340).
 * @param {Record<string, unknown>} job
 * @returns {boolean}
 */
export function isCapacityDeath(job) {
  const conclusion = String(job.conclusion ?? "");
  return (conclusion === "cancelled" || conclusion === "skipped") && !runnerClaimed(job);
}

/**
 * @param {string} path
 * @returns {Record<string, unknown>}
 */
export function ghApi(path) {
  const out = execFileSync("gh", ["api", path], {
    encoding: "utf8",
    timeout: GH_API_CALL_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  return JSON.parse(out);
}

/**
 * Transient API failure: HTTP 5xx or a call timeout (#7014).
 * @param {unknown} err
 * @returns {boolean}
 */
export function isTransientApiError(err) {
  const e = /** @type {{ code?: unknown, killed?: unknown, stderr?: unknown, message?: unknown }} */ (
    err ?? {}
  );
  if (e.code === "ETIMEDOUT" || e.killed === true) return true;
  const text = `${String(e.stderr ?? "")} ${String(e.message ?? "")}`;
  return /\bHTTP 5\d\d\b/.test(text) || /\b(timed out|ETIMEDOUT)\b/i.test(text);
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* poll interval */
  }
}

/**
 * Jobs-API read with backoff retries on transient failures, inside the deadline.
 * Returns the payload, or `{ error }` naming the API failure (#7014).
 * @param {(path: string) => Record<string, unknown>} api
 * @param {string} path
 * @param {number} deadline
 * @param {() => number} now
 * @param {(ms: number) => void} sleep
 * @returns {{ payload: Record<string, unknown> } | { error: string }}
 */
function readWithRetry(api, path, deadline, now, sleep) {
  let attempt = 0;
  for (;;) {
    try {
      return { payload: api(path) };
    } catch (err) {
      const reason = String(
        /** @type {{ message?: unknown }} */ (err ?? {}).message ?? err,
      ).split("\n")[0];
      if (!isTransientApiError(err)) {
        return { error: `jobs API call failed (not retryable): ${reason}` };
      }
      attempt += 1;
      const backoff = GH_API_RETRY_BASE_MS * 2 ** (attempt - 1);
      if (attempt > GH_API_MAX_RETRIES || now() + backoff >= deadline) {
        return {
          error:
            `jobs API call failed after ${attempt} attempt(s) ` +
            `(transient 5xx or timeout, retries exhausted or deadline reached): ${reason}`,
        };
      }
      console.error(`jobs API transient failure (attempt ${attempt}); retrying in ${backoff}ms: ${reason}`);
      sleep(backoff);
    }
  }
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {{ ghApi?: (path: string) => Record<string, unknown>, now?: () => number, sleep?: (ms: number) => void }} [deps]
 * @returns {number}
 */
export function resolveAuthoritativeLane(env, deps = {}) {
  const api = deps.ghApi ?? ghApi;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? sleepSync;

  const repo = env.REPO;
  const runId = env.RUN_ID;
  const want = env.WANT_FAILOVER === "true";
  const failover = env.FAILOVER_RESULT ?? "skipped";
  const needle = env.PRIMARY_NEEDLE;
  const label = env.SUITE_LABEL;

  if (!repo || !runId || needle == null || label == null) {
    console.error("REPO, RUN_ID, PRIMARY_NEEDLE, and SUITE_LABEL are required");
    return 2;
  }

  // #6584: on a master push the `changes` job made the one lookup and found a
  // passed queue run of this workflow on this exact commit. Cite it; no second read.
  const queueRunId = env.QUEUE_RUN_ID ?? "";
  const queueAttempt = env.QUEUE_RUN_ATTEMPT ?? "";
  if (env.QUEUE_PASSED === "true" && /^\d+$/.test(queueRunId) && /^\d+$/.test(queueAttempt)) {
    console.log(
      `Authoritative ${label} green via queue run (#6584): ` +
        `https://github.com/${repo}/actions/runs/${queueRunId}/attempts/${queueAttempt} ` +
        `(attempt ${queueAttempt})`,
    );
    return 0;
  }

  if (want) {
    if (failover === "success") {
      console.log(`Authoritative ${label} green via GH-hosted failover (#2672/#3168)`);
      return 0;
    }
    console.error(`::error::${label} failover requested but result=${failover}`);
    return 1;
  }

  // #7014: optional budget, set by ci.yml on the merge-gate aggregator only.
  let deadlineMs = DEFAULT_OBSERVATION_DEADLINE_MS;
  const budgetRaw = env.OBSERVATION_BUDGET_MINUTES;
  const budgeted = budgetRaw != null && budgetRaw !== "";
  if (budgeted) {
    const minutes = Number(budgetRaw);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      console.error(`::error::OBSERVATION_BUDGET_MINUTES must be a positive number, got ${budgetRaw}`);
      return 2;
    }
    deadlineMs = minutes * 60 * 1000;
  }
  const deadline = now() + deadlineMs;
  while (now() < deadline) {
    const read = readWithRetry(
      api,
      `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`,
      deadline,
      now,
      sleep,
    );
    if ("error" in read) {
      console.error(`::error::${label} ${read.error}`);
      return 1;
    }
    const payload = read.payload;
    const match = selectPrimaryJob(needle, payload);
    if (match == null) {
      sleep(15_000);
      continue;
    }
    const status = match.status;
    const conclusion = match.conclusion;
    const started = match.started_at;
    const runner = match.runner_name;
    console.log(
      `primary status=${status} conclusion=${conclusion} started_at=${started} runner_name=${runner}`,
    );
    if (status === "completed") {
      if (conclusion === "success") {
        console.log(`Authoritative ${label} green via Blacksmith primary (#2672)`);
        return 0;
      }
      if (isCapacityDeath(match)) {
        console.error(
          `::error::${label} Blacksmith primary ${conclusion} without a ` +
            `runner claim and failover was not armed — capacity-watchdog/` +
            `capacity-arm should have set WANT_FAILOVER (#3168/#3340)`,
        );
        return 1;
      }
      console.error(`::error::Blacksmith ${label} primary concluded ${conclusion}`);
      return 1;
    }
    sleep(15_000);
  }

  console.error(
    budgeted
      ? `::error::Observation budget of ${budgetRaw} minutes exhausted waiting for Blacksmith ${label} primary to complete (timed out, hung or missing)`
      : `::error::Timed out waiting for Blacksmith ${label} primary`,
  );
  return 1;
}

function main() {
  process.exitCode = resolveAuthoritativeLane(process.env);
}

const invokedDirectly =
  Boolean(process.argv[1]) &&
  process.argv[1].replaceAll("\\", "/").endsWith("resolve-ci-authoritative-lane.mjs");

if (invokedDirectly) {
  main();
}
