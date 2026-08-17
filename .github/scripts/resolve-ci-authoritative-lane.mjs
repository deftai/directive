#!/usr/bin/env node
/**
 * Resolve the authoritative CI lane result for a required aggregator job
 * (#2672 / #3168 / #3340).
 *
 * Env:
 *   REPO, RUN_ID, GH_TOKEN (via gh), WANT_FAILOVER, FAILOVER_RESULT,
 *   PRIMARY_NEEDLE (lowercase substring of primary job name), SUITE_LABEL
 *
 * When WANT_FAILOVER=true, the GH-hosted failover job result is authoritative.
 * When WANT_FAILOVER=false, the Blacksmith primary is polled until completed.
 * Primary/failover lane job names are never branch-protection required names —
 * only the aggregator job names in ci.yml are.
 */

import { execFileSync } from "node:child_process";

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
  const out = execFileSync("gh", ["api", path], { encoding: "utf8" });
  return JSON.parse(out);
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* poll interval */
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

  if (want) {
    if (failover === "success") {
      console.log(`Authoritative ${label} green via GH-hosted failover (#2672/#3168)`);
      return 0;
    }
    console.error(`::error::${label} failover requested but result=${failover}`);
    return 1;
  }

  const deadline = now() + 6 * 60 * 60 * 1000;
  while (now() < deadline) {
    const payload = api(`repos/${repo}/actions/runs/${runId}/jobs?per_page=100`);
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

  console.error(`::error::Timed out waiting for Blacksmith ${label} primary`);
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
