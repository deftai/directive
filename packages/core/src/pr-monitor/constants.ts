/** Exit codes mirroring scripts/monitor_pr.py. */
export const EXIT_CLEAN = 0;
export const EXIT_CAP_REACHED = 1;
export const EXIT_CONFIG_ERROR = 2;
export const EXIT_PR_TERMINAL = 3;
/** Sustained required-context absence (#3389). Distinct from CAP-REACHED. */
export const EXIT_ABSENT_REQUIRED = 4;

/**
 * First-poll absence is normal (check-runs take time after a head push).
 * Escalate on the next consecutive `ci_absent_required` poll (#3389).
 */
export const ABSENT_REQUIRED_GRACE_POLLS = 1;

/** Adaptive cadence (seconds, repeats). Last repeat is a soft ceiling. */
export const DEFAULT_CADENCE: ReadonlyArray<readonly [number, number]> = [
  [60, 3],
  [180, 3],
  [300, 99],
] as const;
