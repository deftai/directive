/** Framework drift threshold (D14 / #1133). */
export const DRIFT_MIN_ISSUES = 3;

export const CACHE_DIR_NAME = ".deft-cache";
export const CACHE_SOURCE = "github-issue";

/** Structured drift report — mirrors Python `DriftReport`. */
export interface DriftReport {
  readonly labels: Readonly<Record<string, number>>;
  readonly milestones: Readonly<Record<string, number>>;
  readonly total: number;
  readonly threshold: number;
}

export function isEmptyReport(report: DriftReport): boolean {
  return Object.keys(report.labels).length === 0 && Object.keys(report.milestones).length === 0;
}
