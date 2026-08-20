/**
 * Intersect an Istanbul coverage-final.json report with changed lines (#3514).
 *
 * The 90% default is per-change coverage of added/modified branches.
 * The project vitest floor (75) is a collapse detector for the aggregate.
 * They are not interchangeable.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

/** Per-commit coverage of added/modified branches. Not the 75 global floor. */
export const DEFAULT_DIFF_COVERAGE_THRESHOLD = 90;

interface IstanbulLoc {
  readonly start?: { readonly line?: number };
}

interface IstanbulBranchMapEntry {
  readonly line?: number;
  readonly type?: string;
  readonly loc?: IstanbulLoc;
  readonly locations?: readonly IstanbulLoc[];
}

interface IstanbulFileCoverage {
  readonly path?: string;
  readonly b?: Readonly<Record<string, readonly number[]>>;
  readonly branchMap?: Readonly<Record<string, IstanbulBranchMapEntry>>;
}

export interface UncoveredChangedBranch {
  readonly path: string;
  readonly line: number;
  readonly branchId: string;
  readonly pathIndex: number;
  readonly type: string;
}

export interface DiffCoverageReport {
  readonly reportPresent: boolean;
  readonly skippedReason: string | null;
  readonly changedBranchTotal: number;
  readonly changedBranchCovered: number;
  readonly percent: number;
  readonly threshold: number;
  readonly uncovered: readonly UncoveredChangedBranch[];
  readonly belowThreshold: boolean;
}

export interface DiffCoverageOptions {
  readonly projectRoot: string;
  readonly coverageReportPath: string;
  readonly changedLinesByFile: ReadonlyMap<string, ReadonlySet<number>>;
  readonly threshold?: number;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function normalizeReportPath(
  projectRoot: string,
  rawKey: string,
  file: IstanbulFileCoverage,
): string {
  const candidate = file.path && file.path.length > 0 ? file.path : rawKey;
  const rel = isAbsolute(candidate) ? relative(projectRoot, candidate) : candidate;
  return toPosix(rel);
}

function emptyReport(
  threshold: number,
  skippedReason: string | null,
  reportPresent: boolean,
): DiffCoverageReport {
  return {
    reportPresent,
    skippedReason,
    changedBranchTotal: 0,
    changedBranchCovered: 0,
    percent: 100,
    threshold,
    uncovered: [],
    belowThreshold: false,
  };
}

function branchLine(meta: IstanbulBranchMapEntry | undefined, pathIndex: number): number {
  const loc = meta?.locations?.[pathIndex];
  return loc?.start?.line ?? meta?.loc?.start?.line ?? meta?.line ?? 0;
}

/**
 * Measure coverage of Istanbul branch paths whose line is in the diff.
 * Missing or unreadable reports skip (warn-first); they are not a config error.
 */
export function evaluateDiffCoverage(options: DiffCoverageOptions): DiffCoverageReport {
  const threshold = options.threshold ?? DEFAULT_DIFF_COVERAGE_THRESHOLD;
  const reportPath = options.coverageReportPath;
  if (!existsSync(reportPath)) {
    return emptyReport(threshold, `coverage report missing at ${reportPath}`, false);
  }

  let rawReport: Record<string, IstanbulFileCoverage>;
  try {
    rawReport = JSON.parse(readFileSync(reportPath, "utf8")) as Record<
      string,
      IstanbulFileCoverage
    >;
  } catch (err: unknown) {
    return emptyReport(
      threshold,
      `unreadable coverage report at ${reportPath}: ${String((err as Error).message)}`,
      false,
    );
  }

  const changedByPosix = new Map<string, ReadonlySet<number>>();
  for (const [path, lines] of options.changedLinesByFile) {
    changedByPosix.set(toPosix(path), lines);
  }

  const uncovered: UncoveredChangedBranch[] = [];
  let total = 0;
  let covered = 0;

  for (const [rawKey, file] of Object.entries(rawReport)) {
    const relPath = normalizeReportPath(options.projectRoot, rawKey, file);
    const changedLines = changedByPosix.get(relPath);
    if (changedLines === undefined || changedLines.size === 0) {
      continue;
    }
    if (!file.b) {
      continue;
    }
    for (const [branchId, hits] of Object.entries(file.b)) {
      const meta = file.branchMap?.[branchId];
      for (let pathIndex = 0; pathIndex < hits.length; pathIndex += 1) {
        const count = hits[pathIndex] ?? 0;
        const line = branchLine(meta, pathIndex);
        if (!changedLines.has(line)) {
          continue;
        }
        total += 1;
        if (count > 0) {
          covered += 1;
          continue;
        }
        uncovered.push({
          path: relPath,
          line,
          branchId,
          pathIndex,
          type: meta?.type ?? "branch",
        });
      }
    }
  }

  uncovered.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.line - b.line ||
      a.branchId.localeCompare(b.branchId) ||
      a.pathIndex - b.pathIndex,
  );

  const percent = total === 0 ? 100 : (covered / total) * 100;
  const belowThreshold = total > 0 && percent + 1e-9 < threshold;
  return {
    reportPresent: true,
    skippedReason: null,
    changedBranchTotal: total,
    changedBranchCovered: covered,
    percent,
    threshold,
    uncovered,
    belowThreshold,
  };
}

export function hasDiffCoverageFindings(report: DiffCoverageReport): boolean {
  return report.uncovered.length > 0 || report.belowThreshold;
}
