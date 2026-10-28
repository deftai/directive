import * as childProcess from "node:child_process";
import { join, relative } from "node:path";
import {
  admitGateOverrideForAttempt,
  type GateOverrideAdmissionReceipt,
  isGateOverrideEligibleRefuseCode,
} from "../authz/gate-override.js";
import {
  type CoverageApplicabilityResult,
  evaluateCoverageApplicability,
} from "../coverage-applicability/index.js";
import {
  COVERAGE_MODE_INITIAL_REMINDER,
  type CoverageMode,
  isCoverageModeSkipAuthorized,
  resolveCoverageMode,
} from "../policy/coverage-mode.js";
import {
  coverageReportPresence,
  readCoverageReportNoFollow,
} from "../pre-pr-controller/coverage-report.js";
import {
  COVERAGE_HEADROOM_MODE_SKIP,
  COVERAGE_HEADROOM_NOT_APPLICABLE_SKIP,
  COVERAGE_HEADROOM_WAIVED_SKIP,
} from "../pre-pr-controller/phases.js";
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

export interface CoverageApplicabilityArtifact {
  readonly schema: "deft.coverage-applicability.v1";
  readonly outcome: CoverageApplicabilityResult["outcome"] | "waived" | "mode-skip";
  readonly skipReason:
    | typeof COVERAGE_HEADROOM_NOT_APPLICABLE_SKIP
    | typeof COVERAGE_HEADROOM_WAIVED_SKIP
    | typeof COVERAGE_HEADROOM_MODE_SKIP
    | null;
  readonly reason: string;
  readonly binding: {
    readonly baseSha: string;
    readonly headSha: string;
    readonly treeHash: string;
  };
  /** Present when outcome is waived (#5674); cites the gate-override admission receipt. */
  readonly admission?: {
    readonly grantId: string;
    readonly attemptId: string;
    readonly refuseCode: string;
    readonly reviewObligation: string;
    readonly admittedAt: string;
    readonly reused: boolean;
  } | null;
  /** Present when outcome is mode-skip (#5791); carries effective mode + standing reminder. */
  readonly coverageMode?: {
    readonly mode: CoverageMode;
    readonly source: string;
    readonly reminder: string | null;
  } | null;
}

export interface CoverageHotspotsResult {
  /**
   * 0 = measured pass; 1 = floor/headroom fail; 2 = config/refuse;
   * 3 = authorized N/A; 4 = gate-override waived refuse (never pass);
   * 5 = coverageMode posture skip (never pass / never exit-0 N/A).
   */
  readonly exitCode: 0 | 1 | 2 | 3 | 4 | 5;
  readonly report: CoverageHotspotsReport | null;
  readonly message: string;
  readonly applicability?: CoverageApplicabilityArtifact | null;
}

export interface CoverageHotspotsOptions {
  readonly projectRoot: string;
  readonly coverageDir?: string;
  readonly minHeadroomPp?: number;
  readonly baseRef?: string | null;
  readonly pathFilter?: readonly string[] | null;
  readonly useDiffPaths?: boolean;
  readonly lowestModuleLimit?: number;
  /**
   * When set, run the shared applicability classifier before requiring
   * coverage-final.json (#5421 Prefer-A Bound). Caller pathFilter never
   * authorizes classification / N/A.
   */
  readonly inputBinding?: {
    readonly baseSha: string;
    readonly headSha: string;
    readonly treeHash: string;
  } | null;
  /** Default true when inputBinding is set; false skips classifier pre-check. */
  readonly checkApplicability?: boolean;
  /**
   * Grant-bound attempt id for #5674 waived/exit-4. Solo hotspots without this
   * keep refuse as exit 2. Inspect-only paths omit this so admission is not consumed.
   */
  readonly attemptId?: string | null;
  readonly worktree?: string | null;
  readonly evaluatorId?: string | null;
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
  const mergeBase = runGit(["merge-base", baseRef, "HEAD"], projectRoot).trim();
  return splitLines(runGit(["diff", "--name-only", mergeBase, "HEAD"], projectRoot));
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

/** Fixed message for a report path that is not a readable regular file (symlink, dir, error). */
export const COVERAGE_REPORT_NOT_REGULAR_FILE =
  "coverage-hotspots: coverage report is not a regular file";

function configError(message: string): CoverageHotspotsResult {
  return { exitCode: 2, report: null, message };
}

function buildApplicabilityArtifact(
  result: CoverageApplicabilityResult,
  binding: { readonly baseSha: string; readonly headSha: string; readonly treeHash: string },
): CoverageApplicabilityArtifact {
  return {
    schema: "deft.coverage-applicability.v1",
    outcome: result.outcome,
    skipReason: result.outcome === "not-applicable" ? COVERAGE_HEADROOM_NOT_APPLICABLE_SKIP : null,
    reason:
      result.outcome === "not-applicable"
        ? result.reason
        : result.outcome === "applicable"
          ? `coverable paths: ${result.coverablePaths.join(", ")}`
          : result.reason,
    binding: {
      baseSha: binding.baseSha,
      headSha: binding.headSha,
      treeHash: binding.treeHash,
    },
    admission: null,
  };
}

function buildWaivedArtifact(
  refuse: Extract<CoverageApplicabilityResult, { outcome: "refuse" }>,
  binding: { readonly baseSha: string; readonly headSha: string; readonly treeHash: string },
  receipt: GateOverrideAdmissionReceipt,
  reused: boolean,
): CoverageApplicabilityArtifact {
  return {
    schema: "deft.coverage-applicability.v1",
    outcome: "waived",
    skipReason: COVERAGE_HEADROOM_WAIVED_SKIP,
    reason: `coverage-hotspots: waived (${COVERAGE_HEADROOM_WAIVED_SKIP}); refuse=${refuse.code}`,
    binding: {
      baseSha: binding.baseSha,
      headSha: binding.headSha,
      treeHash: binding.treeHash,
    },
    admission: {
      grantId: receipt.grantId,
      attemptId: receipt.attemptId,
      refuseCode: receipt.refuseCode,
      reviewObligation: receipt.reviewObligation,
      admittedAt: receipt.admittedAt,
      reused,
    },
  };
}

function waivedResult(artifact: CoverageApplicabilityArtifact): CoverageHotspotsResult {
  const payload = `${JSON.stringify(artifact, null, 2)}\n`;
  return {
    exitCode: 4,
    report: null,
    message:
      `coverage-hotspots: waived (${COVERAGE_HEADROOM_WAIVED_SKIP})\n` +
      `  Record coverage_headroom via exit 4 + skip reason "${COVERAGE_HEADROOM_WAIVED_SKIP}".\n` +
      `  Never treat waived as measured pass / exit 0.\n` +
      payload,
    applicability: artifact,
  };
}

function buildModeSkipArtifact(
  mode: CoverageMode,
  source: string,
  binding: { readonly baseSha: string; readonly headSha: string; readonly treeHash: string },
  coverablePaths: readonly string[],
): CoverageApplicabilityArtifact {
  const reminder = mode === "initial" ? COVERAGE_MODE_INITIAL_REMINDER : null;
  const strengthen =
    reminder !== null && coverablePaths.length > 0
      ? ` (coverable paths present: ${coverablePaths.slice(0, 8).join(", ")}${coverablePaths.length > 8 ? ", …" : ""})`
      : "";
  return {
    schema: "deft.coverage-applicability.v1",
    outcome: "mode-skip",
    skipReason: COVERAGE_HEADROOM_MODE_SKIP,
    reason:
      `coverage-hotspots: mode-skip (${COVERAGE_HEADROOM_MODE_SKIP}); coverageMode=${mode}` +
      (reminder !== null ? `; reminder=${reminder}${strengthen}` : ""),
    binding: {
      baseSha: binding.baseSha,
      headSha: binding.headSha,
      treeHash: binding.treeHash,
    },
    admission: null,
    coverageMode: {
      mode,
      source,
      reminder: reminder !== null ? `${reminder}${strengthen}` : null,
    },
  };
}

function modeSkipResult(artifact: CoverageApplicabilityArtifact): CoverageHotspotsResult {
  const payload = `${JSON.stringify(artifact, null, 2)}\n`;
  const reminderLine =
    artifact.coverageMode?.reminder !== null && artifact.coverageMode?.reminder !== undefined
      ? `  Reminder: ${artifact.coverageMode.reminder}\n`
      : "";
  return {
    exitCode: 5,
    report: null,
    message:
      `coverage-hotspots: mode-skip (${COVERAGE_HEADROOM_MODE_SKIP})\n` +
      `  Record coverage_headroom via exit 5 + skip reason "${COVERAGE_HEADROOM_MODE_SKIP}".\n` +
      `  Never treat mode-skip as measured pass / exit 0; distinct from inert N/A.\n` +
      reminderLine +
      payload,
    applicability: artifact,
  };
}

function resolveApplicabilityBinding(
  projectRoot: string,
  options: CoverageHotspotsOptions,
): { readonly baseSha: string; readonly headSha: string; readonly treeHash: string } | null {
  if (options.inputBinding) return options.inputBinding;
  // Explicit pathFilter-only invocations are diagnostic samples — not applicability authority.
  if (options.pathFilter && options.pathFilter.length > 0 && options.useDiffPaths === false) {
    return null;
  }
  try {
    const baseRef = resolveBaseRef(projectRoot, options.baseRef);
    // Reviewed changes = merge-base(base, HEAD)..HEAD so target-tip churn is not
    // classified as feature deletions (#5421 Greptile / Prefer-A binding).
    const baseSha = runGit(["merge-base", baseRef, "HEAD"], projectRoot).trim();
    const headSha = runGit(["rev-parse", "HEAD"], projectRoot).trim();
    const treeHash = runGit(["rev-parse", "HEAD^{tree}"], projectRoot).trim();
    return { baseSha, headSha, treeHash };
  } catch {
    return null;
  }
}

export function evaluateCoverageHotspots(options: CoverageHotspotsOptions): CoverageHotspotsResult {
  const projectRoot = options.projectRoot;
  const coverageDir = options.coverageDir ?? join(projectRoot, "coverage");
  const minHeadroomPp = options.minHeadroomPp ?? DEFAULT_MIN_HEADROOM_PP;
  const lowestModuleLimit = options.lowestModuleLimit ?? DEFAULT_LOWEST_MODULE_LIMIT;
  const useDiffPaths = options.useDiffPaths ?? true;
  const checkApplicability =
    options.checkApplicability ?? (options.inputBinding != null || useDiffPaths);
  const binding = checkApplicability ? resolveApplicabilityBinding(projectRoot, options) : null;

  const reportPath = join(coverageDir, "coverage-final.json");
  // lstat presence: a symlink, directory or unreadable path refuses (never followed).
  const presence = coverageReportPresence(reportPath);
  if (presence === null) {
    return configError(COVERAGE_REPORT_NOT_REGULAR_FILE);
  }
  const reportExists = presence === "present";
  let pendingWaived: CoverageApplicabilityArtifact | null = null;
  let classifiedCoverablePaths: readonly string[] = [];

  // Prefer-A Bound limb 4: classify before requiring Istanbul when applicability is in scope.
  // Caller pathFilter never authorizes N/A. N/A rests on applicability alone: an inert
  // diff emits exit 3 whether or not a report exists (retires the #5421 inert-diff
  // Istanbul floor; CI vitest coverage thresholds still apply at merge).
  if (checkApplicability && binding !== null) {
    const applicability = evaluateCoverageApplicability({
      projectRoot,
      baseSha: binding.baseSha,
      headSha: binding.headSha,
      treeHash: binding.treeHash,
    });
    if (applicability.outcome === "applicable") {
      classifiedCoverablePaths = applicability.coverablePaths;
    }
    const artifact = buildApplicabilityArtifact(applicability, binding);

    if (applicability.outcome === "not-applicable") {
      const payload = `${JSON.stringify(artifact, null, 2)}\n`;
      return {
        exitCode: 3,
        report: null,
        message:
          `coverage-hotspots: not-applicable (${COVERAGE_HEADROOM_NOT_APPLICABLE_SKIP})\n` +
          `  Record coverage_headroom via non-zero exit + skip reason ` +
          `"${COVERAGE_HEADROOM_NOT_APPLICABLE_SKIP}".\n` +
          payload,
        applicability: artifact,
      };
    }

    if (applicability.outcome === "refuse") {
      const attemptId = (options.attemptId ?? "").trim();
      const measuredException =
        (applicability.code === "empty-selection" || applicability.code === "dirty-tree") &&
        reportExists;

      // #5674: grant-bound attemptId → admit + exit 4 waived (never exit 0).
      // Measured Istanbul floor/headroom failure still dominates when a report exists.
      if (attemptId.length > 0) {
        if (!isGateOverrideEligibleRefuseCode(applicability.code)) {
          return {
            exitCode: 2,
            report: null,
            message: `${applicability.reason}\n`,
            applicability: artifact,
          };
        }
        const admitted = admitGateOverrideForAttempt(projectRoot, {
          refuseCode: applicability.code,
          baseSha: binding.baseSha,
          headSha: binding.headSha,
          treeHash: binding.treeHash,
          attemptId,
          observedRefuseReason: applicability.reason,
          worktree: options.worktree,
          evaluatorId: options.evaluatorId,
        });
        if (!admitted.ok) {
          return {
            exitCode: 2,
            report: null,
            message: `${admitted.reason}\n`,
            applicability: artifact,
          };
        }
        const waived = buildWaivedArtifact(
          applicability,
          binding,
          admitted.receipt,
          admitted.reused,
        );
        if (!reportExists) {
          return waivedResult(waived);
        }
        // Report present: continue measured; remap exit 0 → 4 after floor check.
        pendingWaived = waived;
      } else if (!measuredException) {
        // Fail closed on refuse even when a prior report exists — unknown/mismatched
        // diffs must not inherit a measured pass from stale Istanbul dogfood.
        // Solo hotspots without an explicit grant-bound attempt id keep exit 2.
        // Exceptions that continue to the measured floor when a report exists:
        // - empty-selection: not proof of N/A (Bound limb 4 dogfood)
        // - dirty-tree: blocks N/A only; before-commit measured hotspots must still run
        return {
          exitCode: 2,
          report: null,
          message: `${applicability.reason}\n`,
          applicability: artifact,
        };
      }
    }

    // applicable, or not-applicable with an available report → continue to measured path.
    // Report-missing for applicable work: mode gate (#5791) may authorize exit 5 below.
  }

  if (!reportExists) {
    // #5791: coverageMode initial|disabled → exit 5 + mode artifact before Istanbul demand.
    // Report-present guard above keeps measured path when coverage-final.json exists.
    // Never exit 0; distinct token from inert N/A.
    const modeResolved = resolveCoverageMode(projectRoot);
    if (isCoverageModeSkipAuthorized(modeResolved.mode)) {
      const modeBinding = binding ??
        resolveApplicabilityBinding(projectRoot, { ...options, checkApplicability: true }) ?? {
          baseSha: "unknown",
          headSha: "unknown",
          treeHash: "unknown",
        };
      return modeSkipResult(
        buildModeSkipArtifact(
          modeResolved.mode,
          modeResolved.source,
          modeBinding,
          classifiedCoverablePaths,
        ),
      );
    }
    return configError(
      `coverage-hotspots: coverage report missing at ${reportPath}\n` +
        "  Run tests with coverage first (e.g. vitest run --coverage or task test:coverage).",
    );
  }

  // One no-follow fd read: a swap to a symlink after the presence check refuses.
  const reportText = readCoverageReportNoFollow(reportPath);
  if (reportText === null) {
    return configError(COVERAGE_REPORT_NOT_REGULAR_FILE);
  }
  let rawReport: Record<string, IstanbulFileCoverage>;
  try {
    rawReport = JSON.parse(reportText) as Record<string, IstanbulFileCoverage>;
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
    // Measured floor/headroom failure dominates a coverage-applicability grant (#5674).
    return {
      exitCode: 1,
      report,
      message: formatTextReport(report, true),
      applicability: pendingWaived,
    };
  }

  if (pendingWaived !== null) {
    // Never map waived/override to measured pass / exit 0.
    return waivedResult(pendingWaived);
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
