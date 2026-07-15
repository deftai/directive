import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Shared coverage goal (vitest thresholds). */
export const COVERAGE_GOAL = {
  lines: 85,
  functions: 85,
  branches: 85,
  statements: 85,
} as const;

export type CoverageMetric = keyof typeof COVERAGE_GOAL;

export interface CoverageTotals {
  readonly lines: number;
  readonly functions: number;
  readonly branches: number;
  readonly statements: number;
}

export type CoverageDebtResolution =
  | { readonly kind: "none" }
  | { readonly kind: "valid"; readonly issue: number }
  | { readonly kind: "invalid"; readonly reason: string };

const DEBT_FLAG = "--allow-coverage-debt";
const DEBT_ENV = "DEFT_ALLOW_COVERAGE_DEBT";
const RELEASE_PREFLIGHT_ENV = "DEFT_RELEASE_PREFLIGHT";

/** Parse `#2573`, `2573`, or bare numeric strings. */
export function parseCoverageDebtIssueNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const normalized = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  if (!/^\d+$/.test(normalized)) return null;
  const issue = Number.parseInt(normalized, 10);
  return Number.isFinite(issue) && issue > 0 ? issue : null;
}

/** Parse `--allow-coverage-debt=#N` tokens from argv. */
export function parseCoverageDebtArgv(argv: readonly string[]): CoverageDebtResolution {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (token === DEBT_FLAG) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        return { kind: "invalid", reason: `${DEBT_FLAG} requires an issue number (#N)` };
      }
      const issue = parseCoverageDebtIssueNumber(next);
      return issue === null
        ? { kind: "invalid", reason: `${DEBT_FLAG} value must be #N or N` }
        : { kind: "valid", issue };
    }
    if (token.startsWith(`${DEBT_FLAG}=`)) {
      const value = token.slice(DEBT_FLAG.length + 1);
      const issue = parseCoverageDebtIssueNumber(value);
      return issue === null
        ? { kind: "invalid", reason: `${DEBT_FLAG}= value must be #N or N` }
        : { kind: "valid", issue };
    }
  }
  return { kind: "none" };
}

/**
 * Resolve coverage-debt issue from argv or release-scoped env (#2573 / #1553).
 * Raw env bypass is accepted only during release Step-5 preflight.
 */
export function resolveCoverageDebtIssue(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): CoverageDebtResolution {
  const fromArgv = parseCoverageDebtArgv(argv);
  if (fromArgv.kind !== "none") return fromArgv;

  const rawEnv = env[DEBT_ENV];
  if (rawEnv && env[RELEASE_PREFLIGHT_ENV] === "1") {
    const issue = parseCoverageDebtIssueNumber(rawEnv);
    return issue === null
      ? { kind: "invalid", reason: `${DEBT_ENV} must be a positive integer` }
      : { kind: "valid", issue };
  }

  return { kind: "none" };
}

interface IstanbulBranchHits {
  readonly [branchId: string]: readonly number[];
}

interface IstanbulFileCoverage {
  readonly s?: Readonly<Record<string, number>>;
  readonly f?: Readonly<Record<string, number>>;
  readonly b?: IstanbulBranchHits;
}

/** Aggregate global coverage percentages from istanbul coverage-final.json. */
export function summarizeCoverageFinal(
  coverageFinal: Readonly<Record<string, IstanbulFileCoverage>>,
): CoverageTotals {
  let stmtTotal = 0;
  let stmtCovered = 0;
  let fnTotal = 0;
  let fnCovered = 0;
  let branchTotal = 0;
  let branchCovered = 0;

  for (const file of Object.values(coverageFinal)) {
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
  }

  const pct = (covered: number, total: number): number =>
    total === 0 ? 100 : (covered / total) * 100;

  const statements = pct(stmtCovered, stmtTotal);
  const functions = pct(fnCovered, fnTotal);
  const branches = pct(branchCovered, branchTotal);

  // Istanbul coverage-final.json does not carry pre-aggregated line hit counts —
  // `l` (line map) is optional and its format differs from `s`/`f`/`b`. Using
  // statements as a proxy may overstate line coverage when multiple statements
  // share a single uncovered line.
  return {
    statements,
    functions,
    branches,
    lines: statements, // approximation: actual line coverage may differ
  };
}

export function readCoverageTotalsFromReport(coverageDir: string): CoverageTotals | null {
  const finalPath = join(coverageDir, "coverage-final.json");
  try {
    const raw = readFileSync(finalPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, IstanbulFileCoverage>;
    return summarizeCoverageFinal(parsed);
  } catch {
    return null;
  }
}

export function metricsBelowGoal(totals: CoverageTotals): CoverageMetric[] {
  const missed: CoverageMetric[] = [];
  for (const metric of Object.keys(COVERAGE_GOAL) as CoverageMetric[]) {
    if (totals[metric] + 1e-9 < COVERAGE_GOAL[metric]) {
      missed.push(metric);
    }
  }
  return missed;
}

const sanitizeMetric = (value: string | number): string => String(value).replace(/\r?\n/g, " ");

export function formatCoverageAttribution(issue: number, totals: CoverageTotals): string {
  const lines = [
    `coverage-debt: soft-pass acknowledged for issue #${issue}`,
    `  measured: branches ${sanitizeMetric(totals.branches.toFixed(2))}% | lines ${sanitizeMetric(totals.lines.toFixed(2))}% | functions ${sanitizeMetric(totals.functions.toFixed(2))}% | statements ${sanitizeMetric(totals.statements.toFixed(2))}%`,
    `  goal:     branches ${sanitizeMetric(COVERAGE_GOAL.branches)}% | lines ${sanitizeMetric(COVERAGE_GOAL.lines)}% | functions ${sanitizeMetric(COVERAGE_GOAL.functions)}% | statements ${sanitizeMetric(COVERAGE_GOAL.statements)}%`,
  ];
  return lines.join("\n");
}

/** Count recent release sections citing coverage-debt (CHANGELOG scan). */
export function countRecentCoverageDebtMentions(changelog: string, maxSections = 5): number {
  const versionHeader = /^## \[(?!Unreleased)/m;
  const sections = changelog.split(versionHeader).slice(1, maxSections + 1);
  const pattern = /coverage[- ]debt soft[- ]pass|allow-coverage-debt=#?\d/i;
  return sections.filter((section) => pattern.test(section)).length;
}

export function formatOveruseWarning(recentCount: number): string | null {
  if (recentCount < 2) return null;
  return (
    `coverage-debt WARN: ${recentCount} of the last release sections already cite coverage debt — ` +
    "consider restoring real coverage instead of reusing the escape hatch."
  );
}
