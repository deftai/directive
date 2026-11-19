#!/usr/bin/env node
/**
 * Queue-result reuse lookup for a master push (#6584).
 *
 * With the merge queue on, the queue's group commit becomes the master commit,
 * so the push run tests a commit the queue run of this same workflow already
 * passed. This script makes ONE decision in the `changes` job: did the latest
 * attempt of a `merge_group` run of this workflow, on this exact SHA, complete
 * with success, with both required aggregators successful in that attempt?
 *
 * Env: REPO, RUN_ID (this run), HEAD_SHA, GH_TOKEN (via gh), GITHUB_OUTPUT.
 *
 * Writes `queue_passed`, `queue_run_id` and `queue_run_attempt` to GITHUB_OUTPUT.
 * Any doubt (no run, in progress, failure, cancelled, API error, missing input)
 * writes `queue_passed=false`, so the full stack runs as before. The workflow
 * runs this file from the push's BASE tree, so a pushed commit cannot change
 * its own lookup.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

/** The two required aggregator job names (branch protection). */
export const REQUIRED_AGGREGATORS = ["TypeScript (build + lint)", "Merge gate (task check)"];

/**
 * @param {string} path
 * @returns {Record<string, unknown>}
 */
export function ghApi(path) {
  const out = execFileSync("gh", ["api", path], { encoding: "utf8" });
  return JSON.parse(out);
}

/**
 * @param {{ REPO?: string, RUN_ID?: string, HEAD_SHA?: string }} env
 * @param {(path: string) => Record<string, unknown>} [api]
 * @returns {{ queue_passed: boolean, queue_run_id: string, queue_run_attempt: string, reason: string }}
 */
export function lookupQueueRun(env, api = ghApi) {
  const no = (reason) => ({
    queue_passed: false,
    queue_run_id: "",
    queue_run_attempt: "",
    reason,
  });
  const { REPO: repo, RUN_ID: runId, HEAD_SHA: sha } = env;
  if (!repo || !runId || !sha) return no("missing REPO, RUN_ID or HEAD_SHA");
  try {
    const current = api(`repos/${repo}/actions/runs/${runId}`);
    const workflowId = current.workflow_id;
    if (workflowId == null) return no("current run has no workflow_id");
    const listing = api(
      `repos/${repo}/actions/workflows/${workflowId}/runs?event=merge_group&head_sha=${sha}&per_page=100`,
    );
    const runs = (Array.isArray(listing.workflow_runs) ? listing.workflow_runs : []).filter(
      (run) =>
        run?.event === "merge_group" &&
        run?.head_sha === sha &&
        Number(run?.workflow_id) === Number(workflowId),
    );
    if (runs.length === 0) return no("no merge_group run of this workflow for this SHA");
    const newest = runs.reduce((a, b) => (Number(b.run_number) > Number(a.run_number) ? b : a));
    const attempt = Number(newest.run_attempt);
    if (!Number.isInteger(attempt) || attempt < 1) return no("queue run attempt unreadable");
    if (newest.status !== "completed" || newest.conclusion !== "success") {
      return no(`queue run ${newest.id} attempt ${attempt} is ${newest.status}/${newest.conclusion}`);
    }
    const jobsPayload = api(`repos/${repo}/actions/runs/${newest.id}/attempts/${attempt}/jobs?per_page=100`);
    const jobs = Array.isArray(jobsPayload.jobs) ? jobsPayload.jobs : [];
    for (const name of REQUIRED_AGGREGATORS) {
      const job = jobs.find((j) => j?.name === name);
      if (!job || job.status !== "completed" || job.conclusion !== "success") {
        return no(`queue run ${newest.id} attempt ${attempt}: ${name} is not completed success`);
      }
    }
    return {
      queue_passed: true,
      queue_run_id: String(newest.id),
      queue_run_attempt: String(attempt),
      reason: `queue run ${newest.id} attempt ${attempt} passed this exact commit`,
    };
  } catch (error) {
    return no(`lookup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function main() {
  const result = lookupQueueRun(process.env);
  console.log(`queue reuse: ${result.queue_passed ? "reuse" : "full stack"} (${result.reason})`);
  const lines = [
    `queue_passed=${result.queue_passed ? "true" : "false"}`,
    `queue_run_id=${result.queue_run_id}`,
    `queue_run_attempt=${result.queue_run_attempt}`,
  ];
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  } else {
    console.log(lines.join("\n"));
  }
}

const invokedDirectly =
  Boolean(process.argv[1]) &&
  process.argv[1].replaceAll("\\", "/").endsWith("ci-queue-reuse-lookup.mjs");

if (invokedDirectly) {
  main();
}
