import { existsSync, readFileSync } from "node:fs";
import { resolveEvalPath } from "../layout/resolve.js";
import { GOLDEN_RUNS_HISTORY_REL, type GoldenRunRecord, type GoldenTaskResult } from "./run.js";
import {
  aggregateCellWithVersionPurity,
  type CellVersionPurity,
  evaluateLedgerVersionPurity,
  type MixedVersionPolicy,
} from "./version-pin.js";

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

/** Version purity evidence for report consumers (#3215). */
export interface VersionPurityEvidence {
  readonly pure: boolean;
  readonly summary: string;
  readonly cells: readonly CellVersionPurity[];
  readonly championCellAllowed: boolean;
  readonly challengerCellAllowed: boolean;
  readonly policy: MixedVersionPolicy;
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
  /** Cell-level framework version purity for the reported model (#3215). */
  readonly versionPurity: VersionPurityEvidence;
}

export interface ReportGoldenEvalOptions {
  readonly projectRoot?: string;
  readonly championVersion: string;
  readonly challengerVersion: string;
  readonly model: string;
  /**
   * Mixed-version cell policy (#3215). Default `refuse` fails the report when
   * ledger runs for this model disagree on framework version within a treatment.
   */
  readonly mixedVersionPolicy?: MixedVersionPolicy;
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

/**
 * Map a golden-run ledger row to the #3215 versioned-run identity.
 * Treatment is model@harness@version so cross-version champion/challenger
 * comparisons stay distinct cells; pin disagreements under one version refuse.
 */
export function goldenRunToVersionedRun(record: GoldenRunRecord): {
  frameworkVersion: string;
  treatment: string;
  model: string;
  harness: string;
  runId: string;
} {
  const pin = record.frameworkVersionPin?.frameworkVersion ?? record.directiveVersion;
  return {
    frameworkVersion: pin,
    treatment: `${record.model}@${record.harness}@${record.directiveVersion}`,
    model: record.model,
    harness: record.harness,
    runId: record.runId,
  };
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
  const policy = options.mixedVersionPolicy ?? "refuse";
  const records = readGoldenRuns(projectRoot);
  const modelRecords = records.filter((r) => r.model === options.model);

  // Within each version×model×harness cell, refuse/flag if pins disagree (#3215).
  // Cross-version champion vs challenger is intentional and uses distinct cells.
  const championCellRuns = modelRecords
    .filter((r) => r.directiveVersion === options.championVersion)
    .map(goldenRunToVersionedRun);
  const challengerCellRuns = modelRecords
    .filter((r) => r.directiveVersion === options.challengerVersion)
    .map(goldenRunToVersionedRun);
  const championAgg = aggregateCellWithVersionPurity({
    runs: championCellRuns,
    treatment: `champion@${options.model}@${options.championVersion}`,
    policy,
  });
  const challengerAgg = aggregateCellWithVersionPurity({
    runs: challengerCellRuns,
    treatment: `challenger@${options.model}@${options.challengerVersion}`,
    policy,
  });
  const ledgerPurity = evaluateLedgerVersionPurity(modelRecords.map(goldenRunToVersionedRun));

  if (!championAgg.allowed || !challengerAgg.allowed) {
    const versionPurity: VersionPurityEvidence = {
      pure: false,
      summary: [
        !championAgg.allowed ? championAgg.purity.message : null,
        !challengerAgg.allowed ? challengerAgg.purity.message : null,
      ]
        .filter((line): line is string => line !== null)
        .join(" "),
      cells: [championAgg.purity, challengerAgg.purity],
      championCellAllowed: championAgg.allowed,
      challengerCellAllowed: challengerAgg.allowed,
      policy,
    };
    return {
      code: 1,
      report: null,
      message: `eval:report: mixed framework versions in treatment cell(s) — aggregation refused (#3215)\n  ${versionPurity.summary}`,
    };
  }

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
  const versionPurity: VersionPurityEvidence = {
    pure: championAgg.purity.pure && challengerAgg.purity.pure && ledgerPurity.pure,
    summary: `${championAgg.purity.message} ${challengerAgg.purity.message}`,
    cells: [championAgg.purity, challengerAgg.purity, ...ledgerPurity.cells],
    championCellAllowed: championAgg.allowed,
    challengerCellAllowed: challengerAgg.allowed,
    policy,
  };
  const report: GoldenEvalReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    championVersion: options.championVersion,
    challengerVersion: options.challengerVersion,
    model: options.model,
    championRunId: champion.runId,
    challengerRunId: challenger.runId,
    deltas,
    holdoutTripwire,
    versionPurity,
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
    `  version purity: ${versionPurity.pure ? "ok" : "mixed"} — ${versionPurity.summary}`,
    `  champion cell pin: v${champion.frameworkVersionPin?.frameworkVersion ?? champion.directiveVersion}`,
    `  challenger cell pin: v${challenger.frameworkVersionPin?.frameworkVersion ?? challenger.directiveVersion}`,
  ];

  const code = holdoutTripwire.triggered ? 1 : 0;
  return { code, report, message: lines.join("\n") };
}
