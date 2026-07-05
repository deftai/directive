import { existsSync, readFileSync } from "node:fs";
import { resolveEvalPath } from "../layout/resolve.js";
import { GOLDEN_RUNS_HISTORY_REL, type GoldenRunRecord, type GoldenTaskResult } from "./run.js";

export const REPORT_SCHEMA_VERSION = 1 as const;

/** Metric delta with a simple two-proportion significance test (#896). */
export interface MetricDelta {
  readonly metric: string;
  readonly champion: number;
  readonly challenger: number;
  readonly delta: number;
  readonly zScore: number | null;
  readonly pValue: number | null;
  readonly significantAt05: boolean;
}

/** Holdout tripwire when primary gains do not generalize (#1703 Goodhart guard). */
export interface HoldoutTripwire {
  readonly triggered: boolean;
  readonly summary: string;
  readonly primaryDelta: number;
  readonly holdoutDelta: number;
}

/** Version-diff report between champion and challenger golden runs. */
export interface GoldenEvalReport {
  readonly schemaVersion: typeof REPORT_SCHEMA_VERSION;
  readonly championVersion: string;
  readonly challengerVersion: string;
  readonly model: string;
  readonly championRunId: string;
  readonly challengerRunId: string;
  readonly deltas: readonly MetricDelta[];
  readonly holdoutTripwire: HoldoutTripwire;
}

export interface ReportGoldenEvalOptions {
  readonly projectRoot?: string;
  readonly championVersion: string;
  readonly challengerVersion: string;
  readonly model: string;
}

export interface ReportGoldenEvalResult {
  readonly code: 0 | 1 | 2;
  readonly report: GoldenEvalReport | null;
  readonly message: string;
}

function readGoldenRuns(projectRoot: string): GoldenRunRecord[] {
  const path = resolveEvalPath(projectRoot, GOLDEN_RUNS_HISTORY_REL);
  if (!existsSync(path)) {
    return [];
  }
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const records: GoldenRunRecord[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as GoldenRunRecord);
    } catch {
      // Skip malformed ledger rows.
    }
  }
  return records;
}

/** Pick the latest run for a directive version and model. */
export function findLatestGoldenRun(
  records: readonly GoldenRunRecord[],
  directiveVersion: string,
  model: string,
): GoldenRunRecord | null {
  const matches = records.filter(
    (r) => r.directiveVersion === directiveVersion && r.model === model,
  );
  if (matches.length === 0) {
    return null;
  }
  return matches.reduce((latest, current) =>
    current.recordedAt >= latest.recordedAt ? current : latest,
  );
}

function countPasses(results: readonly GoldenTaskResult[]): { passed: number; total: number } {
  return {
    passed: results.filter((r) => r.passed).length,
    total: results.length,
  };
}

/** Two-proportion z-test (normal approximation). */
export function twoProportionZTest(
  passedA: number,
  totalA: number,
  passedB: number,
  totalB: number,
): { zScore: number | null; pValue: number | null } {
  if (totalA === 0 || totalB === 0) {
    return { zScore: null, pValue: null };
  }
  const p1 = passedA / totalA;
  const p2 = passedB / totalB;
  const pooled = (passedA + passedB) / (totalA + totalB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / totalA + 1 / totalB));
  if (se === 0) {
    return { zScore: null, pValue: null };
  }
  const z = (p2 - p1) / se;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  return { zScore: z, pValue };
}

function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

function metricDelta(
  metric: string,
  championRate: number,
  challengerRate: number,
  championPassed: number,
  championTotal: number,
  challengerPassed: number,
  challengerTotal: number,
): MetricDelta {
  const { zScore, pValue } = twoProportionZTest(
    championPassed,
    championTotal,
    challengerPassed,
    challengerTotal,
  );
  return {
    metric,
    champion: championRate,
    challenger: challengerRate,
    delta: challengerRate - championRate,
    zScore,
    pValue,
    significantAt05: pValue !== null && pValue < 0.05,
  };
}

/** Detect holdout tripwire: primary improves while holdout regresses (#1703). */
export function evaluateHoldoutTripwire(
  champion: GoldenRunRecord,
  challenger: GoldenRunRecord,
): HoldoutTripwire {
  const primaryDelta = challenger.summary.primaryPassRate - champion.summary.primaryPassRate;
  const holdoutDelta = challenger.summary.holdoutPassRate - champion.summary.holdoutPassRate;
  const triggered = primaryDelta > 0.05 && holdoutDelta < -0.05;
  const summary = triggered
    ? "Holdout tripwire: challenger improved primary metrics but holdout regressed -- possible tuning to gated corpus."
    : "Holdout tripwire clear.";
  return { triggered, summary, primaryDelta, holdoutDelta };
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** Diff two directive versions with metric deltas and significance (#1703 Tier 2). */
export function reportGoldenEval(options: ReportGoldenEvalOptions): ReportGoldenEvalResult {
  if (!options.championVersion.trim() || !options.challengerVersion.trim()) {
    return {
      code: 2,
      report: null,
      message: "eval:report: --champion and --challenger are required",
    };
  }
  if (!options.model.trim()) {
    return { code: 2, report: null, message: "eval:report: --model is required" };
  }

  const projectRoot = options.projectRoot ?? process.cwd();
  const records = readGoldenRuns(projectRoot);
  const champion = findLatestGoldenRun(records, options.championVersion, options.model);
  const challenger = findLatestGoldenRun(records, options.challengerVersion, options.model);

  if (champion === null) {
    return {
      code: 1,
      report: null,
      message: `eval:report: no golden run found for champion v${options.championVersion} model=${options.model}`,
    };
  }
  if (challenger === null) {
    return {
      code: 1,
      report: null,
      message: `eval:report: no golden run found for challenger v${options.challengerVersion} model=${options.model}`,
    };
  }

  const championPrimary = champion.results.filter((r) => !r.holdout);
  const challengerPrimary = challenger.results.filter((r) => !r.holdout);
  const championHoldout = champion.results.filter((r) => r.holdout);
  const challengerHoldout = challenger.results.filter((r) => r.holdout);

  const championPrimaryCount = countPasses(championPrimary);
  const challengerPrimaryCount = countPasses(challengerPrimary);
  const championHoldoutCount = countPasses(championHoldout);
  const challengerHoldoutCount = countPasses(challengerHoldout);

  const deltas: MetricDelta[] = [
    metricDelta(
      "primaryPassRate",
      champion.summary.primaryPassRate,
      challenger.summary.primaryPassRate,
      championPrimaryCount.passed,
      championPrimaryCount.total,
      challengerPrimaryCount.passed,
      challengerPrimaryCount.total,
    ),
    metricDelta(
      "holdoutPassRate",
      champion.summary.holdoutPassRate,
      challenger.summary.holdoutPassRate,
      championHoldoutCount.passed,
      championHoldoutCount.total,
      challengerHoldoutCount.passed,
      challengerHoldoutCount.total,
    ),
    metricDelta(
      "overallPassRate",
      champion.summary.passRate,
      challenger.summary.passRate,
      countPasses(champion.results).passed,
      countPasses(champion.results).total,
      countPasses(challenger.results).passed,
      countPasses(challenger.results).total,
    ),
  ];

  const holdoutTripwire = evaluateHoldoutTripwire(champion, challenger);
  const report: GoldenEvalReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    championVersion: options.championVersion,
    challengerVersion: options.challengerVersion,
    model: options.model,
    championRunId: champion.runId,
    challengerRunId: challenger.runId,
    deltas,
    holdoutTripwire,
  };

  const lines = [
    `eval:report champion=v${options.championVersion} challenger=v${options.challengerVersion} model=${options.model}`,
    ...deltas.map((d) => {
      const sig =
        d.pValue === null
          ? "n/a"
          : d.significantAt05
            ? `p=${d.pValue.toFixed(4)} *`
            : `p=${d.pValue.toFixed(4)}`;
      return `  ${d.metric}: ${formatPercent(d.champion)} -> ${formatPercent(d.challenger)} (delta ${(d.delta * 100).toFixed(1)}pp, ${sig})`;
    }),
    `  ${holdoutTripwire.summary}`,
  ];

  const code = holdoutTripwire.triggered ? 1 : 0;
  return { code, report, message: lines.join("\n") };
}
