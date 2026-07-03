/**
 * task pr:watch -- deterministic PR-verdict polling surface (#1056).
 *
 * Three-state exit contract (AC-1): mirrors scripts/preflight_branch.py (#747)
 * and pr:merge-ready (#796) -- the invocation IS the wait, so an orchestrator
 * cannot promise to poll and then silently forget (2026-05-11 three-strikes on
 * #1051 / #1054).
 */

/** CLEAN: SHA-matched, non-errored, no P0/P1, confidence > 3, CI green. */
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
/** --one-shot only: a single probe with no terminal verdict yet. */
export const VERDICT_PENDING = "PENDING";
/** External/config fault mid-probe (unresolvable repo/HEAD, gh unavailable). */
export const VERDICT_CONFIG = "CONFIG";

export const DEFAULT_MAX_WAIT_MINUTES = 30;
export const DEFAULT_POLL_SECONDS = 90;
/**
 * Consecutive polls with a review PRESENT but stuck on a stale (non-HEAD)
 * commit before the loop surfaces STALL instead of waiting the full cap. Keeps
 * a Greptile review that never re-reviews the new HEAD from silently eating the
 * whole 30-minute budget (#1039 STALL terminal).
 */
export const DEFAULT_STALL_THRESHOLD = 3;
