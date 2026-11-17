/**
 * Base-conflict report for `pr:wait-mergeable-and-merge` (#6467).
 *
 * GitHub does not run `pull_request` CI on a PR that conflicts with its base,
 * so the required checks never appear and the monitor ends `absent-required`
 * (or `cap-reached` when other checks failed or are still running). After those
 * two monitor outcomes the verb reads `pulls/<N>` once; when GitHub reports
 * `mergeable_state` `dirty` it reports `base-conflict` and names the fix. A
 * failed read or any other state keeps today's outcome (Bound item 4).
 */

import { makeGateRunner } from "../orphan-active/issue-state.js";
import type { QueueRunGhFn } from "./merge-queue.js";

/** REST `mergeable_state` GitHub reports for a PR that conflicts with its base. */
export const MERGE_STATE_DIRTY = "dirty" as const;

/** Outcome reported in place of a monitor ending when the PR conflicts with its base. */
export const OUTCOME_BASE_CONFLICT = "base-conflict" as const;

/** Monitor outcomes after which the verb reads the PR's merge state (Bound item 1). */
export const BASE_CONFLICT_TRIGGER_OUTCOMES: readonly string[] = ["absent-required", "cap-reached"];

/** One `pulls/<N>` read: GitHub's merge state and the PR's base branch. */
export interface BaseConflictRead {
  readonly mergeableState: string | null;
  readonly baseRef: string | null;
  readonly error: string | null;
}

export type BaseConflictReadFn = (prNumber: number, repo: string) => BaseConflictRead;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Read `mergeable_state` and `base.ref` from one REST `pulls/<N>` response (Bound item 2). */
export function readBaseConflictState(
  prNumber: number,
  repo: string,
  runGh: QueueRunGhFn = makeGateRunner().runGh,
): BaseConflictRead {
  const rc = runGh(["gh", "api", `repos/${repo}/pulls/${prNumber}`]);
  if (rc.returncode !== 0) {
    return {
      mergeableState: null,
      baseRef: null,
      error: `gh api pulls/${prNumber} failed: ${rc.stderr.trim()}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rc.stdout) as unknown;
  } catch {
    return { mergeableState: null, baseRef: null, error: `pulls/${prNumber} is not JSON` };
  }
  const pr = asRecord(parsed);
  if (pr === null) {
    return { mergeableState: null, baseRef: null, error: `pulls/${prNumber} is not an object` };
  }
  return {
    mergeableState: nonEmptyString(pr.mergeable_state),
    baseRef: nonEmptyString(asRecord(pr.base)?.ref),
    error: null,
  };
}

/** True when a monitor outcome is one the conflict read may replace. */
export function isBaseConflictTrigger(outcome: string): boolean {
  return BASE_CONFLICT_TRIGGER_OUTCOMES.includes(outcome);
}

/** True only for a successful read whose state is `dirty`. */
export function isBaseConflict(read: BaseConflictRead): boolean {
  return read.error === null && read.mergeableState === MERGE_STATE_DIRTY;
}

/** Error text for `base-conflict` (Bound item 3). */
export function formatBaseConflictError(
  prNumber: number,
  baseRef: string | null,
  replacedOutcome: string,
): string {
  const branch = baseRef === null ? "the base branch" : `\`${baseRef}\``;
  const parts = [
    baseRef === null
      ? `PR #${prNumber} conflicts with its base branch (GitHub mergeable_state=dirty).`
      : `PR #${prNumber} conflicts with its base branch \`${baseRef}\` (GitHub mergeable_state=dirty).`,
  ];
  if (replacedOutcome === "absent-required") {
    parts.push("Required checks do not run on a conflicted PR, so they did not appear.");
  }
  parts.push(
    `Fix: merge or rebase ${branch} into the PR branch, resolve the conflicts, push, ` +
      "then run task pr:wait-mergeable-and-merge again.",
  );
  parts.push(`Replaces monitor outcome: ${replacedOutcome}.`);
  return parts.join(" ");
}
