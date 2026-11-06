/** Three-state exit codes — mirrors scripts/pr_wait_mergeable.py. */
export const EXIT_MERGED = 0;
export const EXIT_TIMEOUT_OR_ESCALATION = 1;
export const EXIT_CONFIG_ERROR = 2;

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
