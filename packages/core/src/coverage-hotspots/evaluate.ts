import * as childProcess from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  type CoverageMetric,
  type CoverageTotals,
  summarizeCoverageFinal,
} from "../vitest-runner/coverage-debt.js";
import { type CoverageThresholds, readProjectCoverageThresholds } from "./thresholds.js";

export const DEFAULT_MIN_HEADROOM_PP = 0.3;
export const DEFAULT_LOWEST_MODULE_LIMIT = 10;

interface IstanbulBranchMapEntry {
  readonly line?: number;
  readonly type?: string;
  readonly loc?: { readonly start?: { readonly line?: number } };
}

interface IstanbulBranchHits {
  readonly [branchId: string]: readonly number[];
}

interface IstanbulFileCoverage {
  readonly path?: string;
  readonly s?: Readonly<Record<string, number>>;
  readonly f?: Readonly<Record<string, number>>;
  readonly b?: IstanbulBranchHits;
  readonly branchMap?: Readonly<Record<string, IstanbulBranchMapEntry>>;
}

export interface ModuleCoverage {
  readonly path: string;
  readonly lines: number;
  readonly functions: number;
  readonly branches: number;
  readonly statements: number;
}

export interface UncoveredBranchSample {
  readonly path: string;
  readonly line: number;
  readonly branchId: string;
  readonly type: string;
}

export interface CoverageHotspotsReport {
  readonly ok: boolean;
  readonly global: CoverageTotals;
  readonly thresholds: CoverageThresholds;
  readonly headroomPp: Record<CoverageMetric, number>;
  readonly minHeadroomPp: number;
  readonly failReasons: readonly string[];
  readonly lowestModules: readonly ModuleCoverage[];
  readonly uncoveredBranches: readonly UncoveredBranchSample[];
  readonly pathFilter: readonly string[];
  readonly coverageReportPath: string;
}

export interface CoverageHotspotsResult {
  readonly exitCode: 0 | 1 | 2;
  readonly report: CoverageHotspotsReport | null;
  readonly message: string;
}

export interface CoverageHotspotsOptions {
  readonly projectRoot: string;
  readonly coverageDir?: string;
  readonly minHeadroomPp?: number;
  readonly baseRef?: string | null;
  readonly pathFilter?: readonly string[] | null;
  readonly useDiffPaths?: boolean;
  readonly lowestModuleLimit?: number;
}

class GitCommandError extends Error {}

function runGit(args: string[], projectRoot: string): string {
  try {
    return childProcess.execFileSync("git", args, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stderr?: string | Buffer };
    const stderr = String(e.stderr ?? e.message ?? err).trim();
    throw new GitCommandError(`coverage-hotspots: git ${args.join(" ")} failed: ${stderr}`);
  }
}

function splitLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function resolveBaseRef(projectRoot: string, override: string | null | undefined): string {
  if (override && override.trim().length > 0) return override.trim();
  for (const candidate of ["origin/master", "origin/main", "master", "main", "HEAD~1"]) {
    try {
      runGit(["rev-parse", "--verify", "-q", candidate], projectRoot);
      return candidate;
    } catch {
      // try next
    }
  }
  return "HEAD~1";
}

function diffPaths(projectRoot: string, baseRef: string): string[] {
  return splitLines(runGit(["diff", "--name-only", baseRef, "HEAD"], projectRoot));
}

function pct(covered: number, total: number): number {
  return total === 0 ? 100 : (covered / total) * 100;
}

function summarizeFileCoverage(relPath: string, file: IstanbulFileCoverage): ModuleCoverage {
  let stmtTotal = 0;
  let stmtCovered = 0;
  let fnTotal = 0;
  let fnCovered = 0;
  let branchTotal = 0;
  let branchCovered = 0;

  if (file.s) {
    for (const hits of Object.values(file.s)) {
      stmtTotal += 1;
      if (hits > 0) stmtCovered += 1;
    }
  }
  if (file.f) {
    for (const hits of Object.values(file.f)) {
      fnTotal += 1;
      if (hits > 0) fnCovered += 1;
    }
  }
  if (file.b) {
    for (const paths of Object.values(file.b)) {
      for (const hits of paths) {
        branchTotal += 1;
        if (hits > 0) branchCovered += 1;
      }
    }
  }

  const statements = pct(stmtCovered, stmtTotal);
  const functions = pct(fnCovered, fnTotal);
  const branches = pct(branchCovered, branchTotal);

  return {
    path: relPath,
    statements,
    functions,
    branches,
    lines: statements,
  };
}

function normalizeReportPath(
  projectRoot: string,
  rawKey: string,
  file: IstanbulFileCoverage,
): string {
  if (file.path && file.path.length > 0) {
    const abs = file.path;
    if (abs.startsWith(projectRoot)) {
      return relative(projectRoot, abs).replace(/\\/g, "/");
    }
    return abs.replace(/\\/g, "/");
  }
  return rawKey.replace(/\\/g, "/");
}

function pathMatchesFilter(relPath: string, filters: readonly string[]): boolean {
  if (filters.length === 0) return true;
  // Substring only — do not feed CLI/argv filters into RegExp (CodeQL js/regex-injection).
  return filters.some((pattern) => relPath.includes(pattern));
}

function collectUncoveredBranches(
  relPath: string,
  file: IstanbulFileCoverage,
): UncoveredBranchSample[] {
  if (!file.b) return [];
  const samples: UncoveredBranchSample[] = [];
  for (const [branchId, hits] of Object.entries(file.b)) {
    if (!hits.some((count) => count === 0)) continue;
    const meta = file.branchMap?.[branchId];
    const line = meta?.line ?? meta?.loc?.start?.line ?? 0;
    samples.push({
      path: relPath,
      line,
      branchId,
      type: meta?.type ?? "branch",
    });
  }
  return samples;
}

function computeHeadroom(
  totals: CoverageTotals,
  thresholds: CoverageThresholds,
): Record<CoverageMetric, number> {
  return {
    lines: totals.lines - thresholds.lines,
    functions: totals.functions - thresholds.functions,
    branches: totals.branches - thresholds.branches,
    statements: totals.statements - thresholds.statements,
  };
}

function evaluatePassFail(
  totals: CoverageTotals,
  thresholds: CoverageThresholds,
  headroomPp: Record<CoverageMetric, number>,
  minHeadroomPp: number,
): string[] {
  const reasons: string[] = [];
  if (totals.branches + 1e-9 < thresholds.branches) {
    reasons.push(
      `branches ${totals.branches.toFixed(2)}% below project floor ${thresholds.branches}%`,
    );
  }
  if (headroomPp.branches + 1e-9 < minHeadroomPp) {
    reasons.push(
      `branch headroom ${headroomPp.branches.toFixed(2)}pp below minimum ${minHeadroomPp}pp`,
    );
  }
  return reasons;
}

function configError(message: string): CoverageHotspotsResult {
  return { exitCode: 2, report: null, message };
}

export function evaluateCoverageHotspots(options: CoverageHotspotsOptions): CoverageHotspotsResult {
  const projectRoot = options.projectRoot;
  const coverageDir = options.coverageDir ?? join(projectRoot, "coverage");
  const minHeadroomPp = options.minHeadroomPp ?? DEFAULT_MIN_HEADROOM_PP;
  const lowestModuleLimit = options.lowestModuleLimit ?? DEFAULT_LOWEST_MODULE_LIMIT;
  const useDiffPaths = options.useDiffPaths ?? true;

  const reportPath = join(coverageDir, "coverage-final.json");
  if (!existsSync(reportPath)) {
    return configError(
      `coverage-hotspots: coverage report missing at ${reportPath}\n` +
        "  Run tests with coverage first (e.g. vitest run --coverage or task test:coverage).",
    );
  }

  let rawReport: Record<string, IstanbulFileCoverage>;
  try {
    rawReport = JSON.parse(readFileSync(reportPath, "utf8")) as Record<
      string,
      IstanbulFileCoverage
    >;
  } catch (err: unknown) {
    return configError(
      `coverage-hotspots: unreadable coverage report at ${reportPath}: ${String((err as Error).message)}`,
    );
  }

  const totals = summarizeCoverageFinal(rawReport);

  const thresholds = readProjectCoverageThresholds(projectRoot);
  const headroomPp = computeHeadroom(totals, thresholds);

  let pathFilter = options.pathFilter ?? [];
  if (pathFilter.length === 0 && useDiffPaths) {
    try {
      const baseRef = resolveBaseRef(projectRoot, options.baseRef);
      pathFilter = diffPaths(projectRoot, baseRef);
    } catch (err: unknown) {
      const message =
        err instanceof GitCommandError
          ? `${err.message}\n  Recovery: pass explicit --path filters or run inside a git repo.`
          : `coverage-hotspots: ${String((err as Error).message)}`;
      return configError(message);
    }
  }

  const modules: ModuleCoverage[] = [];
  const uncoveredBranches: UncoveredBranchSample[] = [];
  for (const [rawKey, file] of Object.entries(rawReport)) {
    const relPath = normalizeReportPath(projectRoot, rawKey, file);
    modules.push(summarizeFileCoverage(relPath, file));
    if (pathMatchesFilter(relPath, pathFilter)) {
      uncoveredBranches.push(...collectUncoveredBranches(relPath, file));
    }
  }

  modules.sort((a, b) => a.branches - b.branches || a.path.localeCompare(b.path));
  const lowestModules = modules.slice(0, lowestModuleLimit);
  uncoveredBranches.sort(
    (a, b) =>
      a.path.localeCompare(b.path) || a.line - b.line || a.branchId.localeCompare(b.branchId),
  );

  const failReasons = evaluatePassFail(totals, thresholds, headroomPp, minHeadroomPp);
  const report: CoverageHotspotsReport = {
    ok: failReasons.length === 0,
    global: totals,
    thresholds,
    headroomPp,
    minHeadroomPp,
    failReasons,
    lowestModules,
    uncoveredBranches,
    pathFilter,
    coverageReportPath: reportPath,
  };

  if (failReasons.length > 0) {
    return {
      exitCode: 1,
      report,
      message: formatTextReport(report, true),
    };
  }

  return {
    exitCode: 0,
    report,
    message: formatTextReport(report, false),
  };
}

export function formatJsonReport(report: CoverageHotspotsReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function metricLine(label: string, value: number, threshold: number, headroom: number): string {
  return `  ${label.padEnd(12)} ${value.toFixed(2)}%  (floor ${threshold}% | headroom ${headroom.toFixed(2)}pp)`;
}

export function formatTextReport(report: CoverageHotspotsReport, failed: boolean): string {
  const lines: string[] = [];
  lines.push(failed ? "coverage-hotspots: FAIL" : "coverage-hotspots: OK");
  lines.push(`report: ${report.coverageReportPath}`);
  lines.push("global:");
  lines.push(
    metricLine(
      "branches",
      report.global.branches,
      report.thresholds.branches,
      report.headroomPp.branches,
    ),
  );
  lines.push(
    metricLine("lines", report.global.lines, report.thresholds.lines, report.headroomPp.lines),
  );
  lines.push(
    metricLine(
      "functions",
      report.global.functions,
      report.thresholds.functions,
      report.headroomPp.functions,
    ),
  );
  lines.push(
    metricLine(
      "statements",
      report.global.statements,
      report.thresholds.statements,
      report.headroomPp.statements,
    ),
  );
  lines.push(`min branch headroom: ${report.minHeadroomPp}pp`);
  if (report.pathFilter.length > 0) {
    lines.push(
      `path filter (${report.pathFilter.length}): ${report.pathFilter.slice(0, 8).join(", ")}${report.pathFilter.length > 8 ? ", ..." : ""}`,
    );
  }
  if (report.failReasons.length > 0) {
    lines.push("fail reasons:");
    for (const reason of report.failReasons) {
      lines.push(`  - ${reason}`);
    }
  }
  if (report.lowestModules.length > 0) {
    lines.push("lowest modules (branches):");
    for (const mod of report.lowestModules.slice(0, 5)) {
      lines.push(`  - ${mod.path}: branches ${mod.branches.toFixed(2)}%`);
    }
  }
  if (report.uncoveredBranches.length > 0) {
    lines.push("uncovered branch samples:");
    for (const sample of report.uncoveredBranches.slice(0, 12)) {
      lines.push(`  - ${sample.path}:${sample.line} (${sample.type} #${sample.branchId})`);
    }
    if (report.uncoveredBranches.length > 12) {
      lines.push(`  ... ${report.uncoveredBranches.length - 12} more`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Re-export for tests that build synthetic reports. */
export { summarizeCoverageFinal };
