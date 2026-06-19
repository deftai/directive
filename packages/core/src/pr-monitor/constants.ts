/** Exit codes mirroring scripts/monitor_pr.py. */
export const EXIT_CLEAN = 0;
export const EXIT_CAP_REACHED = 1;
export const EXIT_CONFIG_ERROR = 2;
export const EXIT_PR_TERMINAL = 3;

/** Adaptive cadence (seconds, repeats). Last repeat is a soft ceiling. */
export const DEFAULT_CADENCE: ReadonlyArray<readonly [number, number]> = [
  [60, 3],
  [180, 3],
  [300, 99],
] as const;
