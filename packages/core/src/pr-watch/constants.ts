/**
 * task pr:watch -- deterministic PR-verdict polling surface (#1056).
 *
 * Three-state exit contract (AC-1): mirrors scripts/preflight_branch.py (#747)
 * and pr:merge-ready (#796) -- the invocation IS the wait, so an orchestrator
 * cannot promise to poll and then silently forget (2026-05-11 three-strikes on
 * #1051 / #1054).
 */

/**
 * CLEAN: SHA-matched, non-errored, no P0/P1, confidence >= resolved min, CI green.
 * Min defaults to consumer 4 (legacy > 3); dogfood/policy may raise to 5 (#3095).
 */
export const EXIT_CLEAN = 0;
/** NEW_P0_P1: blocking findings on the CURRENT (SHA-matched) review. */
export const EXIT_NEW_P0_P1 = 1;
/** ERRORED | STALL | TIMEOUT | config-error all collapse to a single non-zero. */
export const EXIT_TERMINAL_ERROR = 2;

export const VERDICT_CLEAN = "CLEAN";
export const VERDICT_NEW_P0_P1 = "NEW_P0_P1";
export const VERDICT_ERRORED = "ERRORED";
export const VERDICT_STALL = "STALL";
export const VERDICT_TIMEOUT = "TIMEOUT";
/**
 * Greptile side of the clean gate is satisfied on HEAD but required CI is red
 * (#2688). Exit 2 — fail-loud toward a CI fix loop instead of idle-polling.
 */
export const VERDICT_CI_BLOCKED = "CI_BLOCKED";
/**
 * Required CI is still queued past the capacity-stall budget with no runner
 * claimed (#2672). Exit 2 — wait for auto-failover; never --skip-ci.
 */
export const VERDICT_RUNNER_CAPACITY_STALL = "RUNNER_CAPACITY_STALL";
/**
 * No CI workflow check-run scheduled for HEAD (bots-only or empty) (#3167).
 * Exit 2 — thrash-cap then BLOCKED; do not multi-hour empty-commit loops.
 */
export const VERDICT_CI_NEVER_SCHEDULED = "CI_NEVER_SCHEDULED";
/**
 * Primary CI cancelled and no green required sibling / failover (#3167).
 * Exit 2 — thrash-cap then BLOCKED; workflow arming is sibling #3168.
 */
export const VERDICT_CI_CANCELLED_NO_FAILOVER = "CI_CANCELLED_NO_FAILOVER";
/**
 * No bot reviewer can be expected (presence probe and/or explicit empty
 * plan.policy.review.reviewers) (#3630). Exit 2 — named weather terminal, not
 * CLEAN, TIMEOUT, or STALL. Route to pre-pr self-review.
 */
export const VERDICT_NO_REVIEWER_INSTALLED = "NO_REVIEWER_INSTALLED";
/** --one-shot only: a single probe with no terminal verdict yet. */
export const VERDICT_PENDING = "PENDING";
/** External/config fault mid-probe (unresolvable repo/HEAD, gh unavailable). */
export const VERDICT_CONFIG = "CONFIG";
/** Sticky tip-rot sha_match with no in-flight Greptile Review (#5162). Exit 2. */
export const VERDICT_GREPTILE_SHA_STALL = "GREPTILE_SHA_STALL";
/**
 * PR already squash-/merge-landed (`merged=true` on REST pulls) (#4288).
 * Terminal success, exit 0 — same finish-success family as CLEAN for wait owners.
 * SHA-match / missing Last reviewed must not hold a merged PR.
 */
export const VERDICT_MERGED = "MERGED";
/**
 * PR closed without merge (`state=closed` and `merged=false`) (#4288).
 * Terminal non-success, exit 2 — not CLEAN; workers treat as not shipped.
 */
export const VERDICT_CLOSED_UNMERGED = "CLOSED_UNMERGED";
/** Fail-loud remedy string for Prefer-A Recut greptile-sha-stall (#5162). */
export const GREPTILE_SHA_STALL_REMEDY = "BLOCKED: greptile-sha-stall";
/** Prefer-A sticky-sha clock: elapsed since first sticky tip-rot (borrow ~10 min). */
export const DEFAULT_STICKY_SHA_STALL_SECONDS = Number.parseInt("600", 10);

export const DEFAULT_MAX_WAIT_MINUTES = 30;
export const DEFAULT_POLL_SECONDS = 90;

/**
 * Usage for `task pr:watch -- --help` / `-h` (#2652 / #1056).
 * Canonical surface is the Task verb; engine stem is `pr-watch`.
 */
export const WATCH_HELP =
  "usage: task pr:watch -- <pr_number> [options]\n" +
  "\n" +
  "Blocking poll of a PR Greptile/SLizard review to a terminal three-state\n" +
  "verdict (#1056). The invocation IS the wait — an orchestrator that promises\n" +
  "to poll cannot silently forget. Canonical: `task pr:watch -- <N>`.\n" +
  "Engine / CLI stem: `pr-watch` (also `directive pr watch` / `directive pr:watch`).\n" +
  "\n" +
  "positional arguments:\n" +
  "  pr_number             GitHub pull request number (required unless --help)\n" +
  "\n" +
  "options:\n" +
  "  -h, --help            Show this help and exit 0\n" +
  "  --one-shot            Single probe (PENDING with no terminal verdict → exit 2)\n" +
  "  --json                Emit the AC-4 JSON shape on stdout\n" +
  "  --max-wait-minutes N  Cap for the blocking poll (default: 30).\n" +
  "                        Declared budget for #3153 wall-clock row (#3984):\n" +
  "                        CLI flag or DEFT_PR_WATCH_MAX_WAIT_MINUTES. The\n" +
  "                        30m default is a poll cap, not a declared envelope\n" +
  "                        budget — dual-stop / envelope SLA bind only when\n" +
  "                        a budget is declared.\n" +
  "  --poll-seconds N      Seconds between probes (default: 90)\n" +
  "  --repo OWNER/REPO     Override repository (default: GH_REPO / origin)\n" +
  "  --project-root PATH   Chdir before probing (optional)\n" +
  "\n" +
  "--json notes (#4882 / #5015):\n" +
  "  Output may be pretty-printed multi-line JSON. Wrappers MUST parse the\n" +
  "  full stdout blob (JSON.parse of the whole string). Line-splitting on the\n" +
  "  first '{' line drops CLEAN. Prefer native/blocking pr:watch or Approach 1\n" +
  "  over homemade DONE scripts. Use parsePrWatchJsonStdout from the pr-watch\n" +
  "  package when wrapping --json in-process.\n" +
  "\n" +
  "exit codes:\n" +
  "  0  CLEAN | MERGED  SHA-matched clean review, or REST pulls merged=true (#4288)\n" +
  "  1  NEW_P0_P1   Blocking findings on the current (SHA-matched) review\n" +
  "  2  ERRORED | STALL | TIMEOUT | CI_BLOCKED | RUNNER_CAPACITY_STALL |\n" +
  "     CI_NEVER_SCHEDULED | CI_CANCELLED_NO_FAILOVER | NO_REVIEWER_INSTALLED |\n" +
  "     GREPTILE_SHA_STALL | CLOSED_UNMERGED | config / usage error\n" +
  "\n" +
  "PR lifecycle short-circuit (#4288):\n" +
  "  REST repos/.../pulls/<N> state/merged is checked before Greptile body and\n" +
  "  SHA-match holdout. merged=true → MERGED (exit 0). state=closed and\n" +
  "  merged=false → CLOSED_UNMERGED (exit 2). Open PRs keep the sha_match\n" +
  "  stale-review guard (#1259 / #2313).\n" +
  "\n" +
  "sha_match sticky tip-rot (#5162 Prefer-A Recut):\n" +
  "  After sticky sha_match + non-HEAD Last-reviewed + no in-flight Greptile\n" +
  "  Review on HEAD for DEFAULT_STICKY_SHA_STALL_SECONDS (~10 min), verdict is\n" +
  "  GREPTILE_SHA_STALL with remedy BLOCKED: greptile-sha-stall. Ask once\n" +
  "  (#564 menu option 2) before posting @greptileai review, then re-enter\n" +
  "  native pr:watch. Do not invent freestyle CLEAN pollers; not dest residual.\n";
/**
 * Consecutive polls where the CLEAN gate is wedged on HEAD (!has_blocking &&
 * !is_clean with a holdout other than sha_match) before STALL (#1039). Stale-SHA
 * reads (sha_match holdout) do NOT advance this counter — re-review in flight
 * waits until max-wait cap (#2313 / #1259 INCOMPLETE_BUT_RATED).
 */
export const DEFAULT_STALL_THRESHOLD = 3;
/**
 * Consecutive polls with clean_gate_holdout=ci_failures (Greptile otherwise
 * satisfied) before CI_BLOCKED (#2688). Same default as SHA STALL.
 */
export const DEFAULT_CI_BLOCKED_THRESHOLD = 3;
