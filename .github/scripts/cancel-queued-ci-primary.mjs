#!/usr/bin/env node
/**
 * Cancel still-unclaimed Blacksmith primary jobs before GH-hosted failover
 * (#2672 / #3168 / #3340).
 *
 * Unclaimed means no runner_name. started_at or reusable-workflow caller
 * in_progress is not a claim. Never cancels a job with runner_name (#2652).
 * Jobs already cancelled without a claim need no cancel — failover is armed instead.
 */

import { spawnSync } from "node:child_process";

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
 * True when the job has no runner_name and is still waiting (#3340 / #2652).
 * @param {Record<string, unknown>} job
 * @returns {boolean}
 */
export function isCancelableUnclaimed(job) {
  const status = String(job.status ?? "");
  if (runnerClaimed(job)) return false;
  return status === "queued" || status === "waiting" || status === "requested" || status === "in_progress";
}

/**
 * @param {string[]} argv
 * @param {{ check?: boolean }} [_opts]
 * @returns {unknown}
 */
function defaultRunner(argv, _opts) {
  return spawnSync(argv[0], argv.slice(1), { encoding: "utf8", stdio: "inherit" });
}

/**
 * Cancel unclaimed primary jobs matching needle. Returns cancelled job ids.
 * @param {string} needle
 * @param {Record<string, unknown>} payload
 * @param {{ repo: string, runner?: (argv: string[], opts?: { check?: boolean }) => unknown }} opts
 * @returns {number[]}
 */
export function cancelMatchingPrimaries(needle, payload, { repo, runner }) {
  const run = runner ?? defaultRunner;
  const needleL = needle.toLowerCase();
  /** @type {number[]} */
  const cancelled = [];
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
  for (const job of jobs) {
    const name = String(job?.name ?? "");
    if (!name.toLowerCase().includes(needleL)) continue;
    if (!isCancelableUnclaimed(job)) continue;
    const jid = job.id;
    if (!jid) continue;
    console.log(`canceling queued primary job id=${jid} name=${name}`);
    run(["gh", "api", "-X", "POST", `repos/${repo}/actions/jobs/${jid}/cancel`], {
      check: false,
    });
    cancelled.push(Number(jid));
  }
  return cancelled;
}

function main(argv) {
  if (argv.length !== 2) {
    console.error("usage: cancel-queued-ci-primary.mjs <needle> <jobs_json>");
    process.exitCode = 2;
    return;
  }
  const [needle, raw] = argv;
  const payload = JSON.parse(raw);
  const repo = process.env.REPO;
  if (!repo) {
    console.error("REPO env is required");
    process.exitCode = 2;
    return;
  }
  cancelMatchingPrimaries(needle, payload, { repo });
}

const invokedDirectly =
  Boolean(process.argv[1]) &&
  process.argv[1].replaceAll("\\", "/").endsWith("cancel-queued-ci-primary.mjs");

if (invokedDirectly) {
  main(process.argv.slice(2));
}
