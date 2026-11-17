/** Three-state exit codes — mirrors scripts/pr_wait_mergeable.py. */
export const EXIT_MERGED = 0;
export const EXIT_TIMEOUT_OR_ESCALATION = 1;
export const EXIT_CONFIG_ERROR = 2;
/**
 * Merge-queue mode (#6295): the PR is queued or awaiting admission. Not merged
 * yet; run the printed resume command later. Never reported as merged.
 */
export const EXIT_QUEUE_PENDING = 3;

/**
 * `--wait` (#6423 item 7): seconds between merge-queue reads. A queue run takes
 * minutes; one read a minute keeps each wait to one `rate_limit` probe and one
 * GraphQL query per minute on the shared bucket.
 */
export const MERGE_QUEUE_WAIT_POLL_SECONDS = 60;

/**
 * `--wait` (#6423 item 4): failed queue reads in a row that end the wait with
 * exit 2. Covers a brief read failure; it does not wait through a rate limit.
 */
export const MERGE_QUEUE_WAIT_MAX_FAILED_READS = 3;

/** Why a `--wait` queue wait ended (#6423 item 6). */
export type QueueWaitStopReason = "result" | "cap" | "read-unavailable";

/** Exact GitHub check-run name for the always-on master tip gate (#6071). */
export const MERGE_GATE_TASK_CHECK_NAME = "Merge gate (task check)" as const;

export const OUTCOME_MASTER_MERGE_GATE_RED = "master-merge-gate-red" as const;
export const OUTCOME_HOTFIX_SHAPE_INVALID = "hotfix-shape-invalid" as const;
export const OUTCOME_HOTFIX_ACTOR_DENIED = "hotfix-actor-denied" as const;
export const OUTCOME_FIRST_HOTFIX_BOOTSTRAP = "first-hotfix-bootstrap" as const;
export const OUTCOME_UNSANCTIONED_TEST_SKIP = "unsanctioned-test-skip" as const;

export const HOTFIX_LABEL = "hotfix" as const;

/** Shape (A) restore-green body line (#6071). */
export const HOTFIX_SHAPE_A_RE = /^Hotfix for red Merge gate \(task check\):\s+\S.*$/m;

/** Shape (B) cited-skip body line (#6071). */
export const HOTFIX_SHAPE_B_RE = /^Hotfix skip:\s+deftai\/directive#(\d+)\s*$/m;

/** Citation host for shape-B skipped-test issues (never the PR fork/consumer repo). */
export const HOTFIX_SHAPE_B_ISSUE_REPO = "deftai/directive" as const;

export const FIRST_HOTFIX_BOOTSTRAP_RECOVERY =
  "First-hotfix bootstrap: a human maintainer must open a draft PR, apply the " +
  "`hotfix` label, and include exactly one shape body line — " +
  "`Hotfix for red Merge gate (task check): <summary>` (A) or " +
  "`Hotfix skip: deftai/directive#NNNN` (B). pre-pr-controller does not create that PR.";
