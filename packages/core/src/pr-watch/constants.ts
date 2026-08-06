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
/** --one-shot only: a single probe with no terminal verdict yet. */
export const VERDICT_PENDING = "PENDING";
/** External/config fault mid-probe (unresolvable repo/HEAD, gh unavailable). */
export const VERDICT_CONFIG = "CONFIG";

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
  "  --max-wait-minutes N  Cap for the blocking poll (default: 30)\n" +
  "  --poll-seconds N      Seconds between probes (default: 90)\n" +
  "  --repo OWNER/REPO     Override repository (default: GH_REPO / origin)\n" +
  "  --project-root PATH   Chdir before probing (optional)\n" +
  "\n" +
  "exit codes:\n" +
  "  0  CLEAN       SHA-matched review, confidence >= policy min (default 4; dogfood 5), no P0/P1, CI green\n" +
  "  1  NEW_P0_P1   Blocking findings on the current (SHA-matched) review\n" +
  "  2  ERRORED | STALL | TIMEOUT | CI_BLOCKED | RUNNER_CAPACITY_STALL |\n" +
  "     CI_NEVER_SCHEDULED | CI_CANCELLED_NO_FAILOVER | config / usage error\n";
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
