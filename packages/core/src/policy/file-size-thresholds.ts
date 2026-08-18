/**
 * Single machine-readable source of truth for per-file size guidance (#3424).
 *
 * `coding.md` and companion prose MUST reference these exports. They are
 * review / planning triggers, not a hard line cap (#1488).
 */

/** Preferred size for a focused file. */
export const FILE_SIZE_IDEAL_LINES = 300;

/** Recommended upper bound before a file should be treated as large. */
export const FILE_SIZE_RECOMMENDED_LINES = 500;

/**
 * Review-trigger line count. A declared file at or above this size cannot
 * pass preflight without a recorded split plan or cohesion exemption.
 * Size alone is never a fail-closed reject.
 */
export const FILE_SIZE_REVIEW_TRIGGER_LINES = 1000;

/** Canonical bundle so callers do not restate the three numbers. */
export const FILE_SIZE_THRESHOLDS = {
  idealLines: FILE_SIZE_IDEAL_LINES,
  recommendedLines: FILE_SIZE_RECOMMENDED_LINES,
  reviewTriggerLines: FILE_SIZE_REVIEW_TRIGGER_LINES,
} as const;

export type FileSizeThresholds = typeof FILE_SIZE_THRESHOLDS;
