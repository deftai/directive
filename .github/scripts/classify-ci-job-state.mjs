#!/usr/bin/env node
/**
 * Classify a CI job's queue/start state for #2672 / #3168 / #3340 capacity watchdog.
 *
 * States (stdout, one line):
 *   missing              — no job matching needle in the jobs payload
 *   queued               — still unclaimed (no runner_name), including started_at-only
 *   started              — runner_name set (no failover; #2652)
 *   done                 — completed after a runner claim, or completed success/failure
 *   cancelled_unclaimed  — completed cancelled/skipped with no runner ever claimed
 *                          (capacity death — arm failover like queued past budget; #3168)
 */

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
 * @param {string} needle
 * @param {Record<string, unknown>} payload
 * @returns {Record<string, unknown>[]}
 */
export function matchingJobs(needle, payload) {
  const needleL = needle.toLowerCase();
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
  return jobs.filter((j) => String(j?.name ?? "").toLowerCase().includes(needleL));
}

/**
 * Prefer the reusable-workflow inner `/run` job over the caller wrapper (#3340).
 * @param {string} needle
 * @param {Record<string, unknown>} payload
 * @returns {Record<string, unknown> | null}
 */
export function selectSuiteJob(needle, payload) {
  const matches = matchingJobs(needle, payload);
  if (matches.length === 0) return null;
  const inner = matches.filter((j) => String(j?.name ?? "").includes(" / "));
  const pool = inner.length > 0 ? inner : matches;
  const claimed = pool.filter((j) => runnerClaimed(j));
  if (claimed.length > 0) return claimed[0];
  const completed = pool.filter((j) => String(j?.status ?? "") === "completed");
  if (completed.length > 0) return completed[0];
  return pool[0];
}

/**
 * @param {Record<string, unknown> | null | undefined} match
 * @returns {"missing" | "queued" | "started" | "done" | "cancelled_unclaimed"}
 */
export function classifyJob(match) {
  if (match == null) return "missing";

  const status = String(match.status ?? "");
  const conclusion = String(match.conclusion ?? "");
  const claimed = runnerClaimed(match);

  if (status === "completed") {
    if ((conclusion === "cancelled" || conclusion === "skipped") && !claimed) {
      return "cancelled_unclaimed";
    }
    return "done";
  }

  if (claimed) return "started";
  return "queued";
}

/**
 * @param {string} needle
 * @param {Record<string, unknown>} payload
 * @returns {string}
 */
export function classifyJobsPayload(needle, payload) {
  return classifyJob(selectSuiteJob(needle, payload));
}

function main(argv) {
  if (argv.length !== 2) {
    console.error("usage: classify-ci-job-state.mjs <needle> <jobs_json>");
    process.exitCode = 2;
    return;
  }
  const [needle, raw] = argv;
  const payload = JSON.parse(raw);
  console.log(classifyJobsPayload(needle, payload));
}

const invokedDirectly =
  Boolean(process.argv[1]) &&
  (process.argv[1].endsWith("classify-ci-job-state.mjs") ||
    process.argv[1].replaceAll("\\", "/").endsWith("classify-ci-job-state.mjs"));

if (invokedDirectly) {
  main(process.argv.slice(2));
}
