import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type AutonomyRecommendation,
  CAPACITY_UNIT_COST,
  type CapacityAllocation,
  type CapacityBucket,
  DEFAULT_CAPACITY_UNIT,
  DEFAULT_PENDING_DECISIONS_THRESHOLD,
  pendingDecisionsNudgeLine,
  recommendAutonomyLevel,
  resolveAutonomy,
  resolveCapacityAllocation,
  summarizeDecisionBacklog,
} from "./capacity-policy.js";

export const FORWARD_FOLDERS = ["pending", "active"] as const;
export const BACKWARD_FOLDER = "completed";
export const UNASSIGNED_BUCKET = "unassigned";
export const COST_COVERAGE_FLOOR = 0.5;
const PARENT_KINDS = new Set(["epic", "phase"]);

export interface VbriefRecord {
  readonly bucket: string;
  readonly kind: string;
  readonly weight: number;
  readonly folder: string;
  readonly classified: boolean;
  readonly inWindow: boolean;
  readonly completedAtPresent: boolean;
  readonly isRework: boolean;
  readonly cost: number | null;
}

export interface BucketTally {
  readonly bucketId: string;
  readonly target: number;
  forwardWeight: number;
  backwardWeight: number;
  reworkWeight: number;
  costActual: number | null;
}

export interface CapacityReport {
  readonly configured: boolean;
  readonly source: string;
  readonly unitRequested: string;
  readonly unitEffective: string;
  readonly costFallback: boolean;
  readonly costFallbackReason: string | null;
  readonly windowDays: number;
  readonly minSampleSize: number;
  readonly classifiedCompletions: number;
  readonly unclassifiedCompletions: number;
  readonly advisoryMode: boolean;
  readonly advisoryReasons: string[];
  readonly buckets: BucketTally[];
  readonly totalForward: number;
  readonly totalBackward: number;
  readonly policyError: string | null;
  readonly pendingDecisions: number;
  readonly pendingDecisionsThreshold: number;
  readonly pendingByKind: Readonly<Record<string, number>>;
  readonly pendingNudge: string;
  readonly autonomyEnabled: boolean;
  readonly autonomy: AutonomyRecommendation | null;
}

function parseIso(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = new Date(value.replace("Z", "+00:00"));
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
  } catch {
    return null;
  }
}

function planHasChildren(plan: Record<string, unknown>): boolean {
  const refs = plan.references;
  if (!Array.isArray(refs)) return false;
  return refs.some(
    (ref) =>
      typeof ref === "object" &&
      ref !== null &&
      (ref as Record<string, unknown>).type === "x-vbrief/plan",
  );
}

function coerceCost(value: unknown): number | null {
  if (typeof value === "boolean") return null;
  if (typeof value === "number" && value > 0) return value;
  return null;
}

function recordWeight(
  kind: string,
  plan: Record<string, unknown>,
  metadata: Record<string, unknown>,
  allocation: CapacityAllocation,
): number {
  if (PARENT_KINDS.has(kind)) {
    if (planHasChildren(plan)) return 0;
    const estimated = metadata.estimatedChildren;
    if (typeof estimated === "number" && Number.isInteger(estimated) && estimated > 0) {
      return estimated;
    }
    return allocation.defaultEpicEstimate;
  }
  return 1;
}

export function classifyRecord(
  plan: Record<string, unknown>,
  folder: string,
  allocation: CapacityAllocation,
  now: Date,
): VbriefRecord {
  const metadata =
    typeof plan.metadata === "object" && plan.metadata !== null && !Array.isArray(plan.metadata)
      ? (plan.metadata as Record<string, unknown>)
      : {};
  const kindRaw = metadata.kind;
  const kind = typeof kindRaw === "string" && kindRaw ? kindRaw : "story";

  const explicitBucket = metadata.capacityBucket;
  const classified = typeof explicitBucket === "string" && explicitBucket.trim().length > 0;
  let bucket: string;
  if (classified) {
    bucket = explicitBucket.trim();
  } else if (allocation.defaultBucket) {
    bucket = allocation.defaultBucket;
  } else {
    bucket = UNASSIGNED_BUCKET;
  }

  const weight = recordWeight(kind, plan, metadata, allocation);

  const rawCompletedAt = metadata.completedAt;
  const completedAtPresent = typeof rawCompletedAt === "string" && rawCompletedAt.trim().length > 0;

  let inWindow = false;
  if (folder === BACKWARD_FOLDER) {
    const completedAt = parseIso(rawCompletedAt);
    if (completedAt !== null) {
      const ageDays = (now.getTime() - completedAt.getTime()) / 86400000;
      inWindow = ageDays >= 0 && ageDays <= allocation.windowDays;
    }
  }

  const outcome = metadata.outcome;
  const isRework =
    (typeof outcome === "string" && outcome.toLowerCase() === "rework") || metadata.rework === true;

  return {
    bucket,
    kind,
    weight,
    folder,
    classified,
    inWindow,
    completedAtPresent,
    isRework,
    cost: coerceCost(metadata.cost),
  };
}

export function iterVbriefPlans(
  vbriefRoot: string,
): Array<{ folder: string; plan: Record<string, unknown> }> {
  const out: Array<{ folder: string; plan: Record<string, unknown> }> = [];
  for (const folder of [...FORWARD_FOLDERS, BACKWARD_FOLDER]) {
    const folderPath = join(vbriefRoot, folder);
    if (!existsSync(folderPath) || !statSync(folderPath).isDirectory()) continue;
    for (const name of readdirSync(folderPath).sort()) {
      if (!name.endsWith(".vbrief.json")) continue;
      const child = join(folderPath, name);
      try {
        const data = JSON.parse(readFileSync(child, "utf8")) as unknown;
        const plan =
          typeof data === "object" && data !== null ? (data as Record<string, unknown>).plan : null;
        if (typeof plan === "object" && plan !== null && !Array.isArray(plan)) {
          out.push({ folder, plan: plan as Record<string, unknown> });
        }
      } catch {
        // skip unreadable
      }
    }
  }
  return out;
}

function resolveEffectiveUnit(
  unitRequested: string,
  costEligible: number,
  costWithActual: number,
): [string, boolean, string | null] {
  if (unitRequested !== CAPACITY_UNIT_COST) return [unitRequested, false, null];
  if (costEligible === 0) {
    return [
      DEFAULT_CAPACITY_UNIT,
      true,
      "unit:cost requested but no classified completions carry grounded " +
        "cost actuals -- falling back to advisory vbrief-count " +
        "(cost overlay: none/estimate-only)",
    ];
  }
  const coverage = costWithActual / costEligible;
  if (coverage < COST_COVERAGE_FLOOR) {
    return [
      DEFAULT_CAPACITY_UNIT,
      true,
      `unit:cost requested but only ${costWithActual}/${costEligible} ` +
        `(${Math.round(coverage * 100)}%) classified completions carry grounded cost ` +
        `actuals (< ${Math.round(COST_COVERAGE_FLOOR * 100)}% floor) -- falling back to ` +
        "advisory vbrief-count (cost overlay: none/estimate-only)",
    ];
  }
  return [CAPACITY_UNIT_COST, false, null];
}

export function bucketDeficit(report: CapacityReport, tally: BucketTally): number {
  const targetWeight = tally.target * report.totalBackward;
  return Math.round((targetWeight - tally.backwardWeight) * 10000) / 10000;
}

export function computeReport(
  projectRoot: string,
  options: { now?: Date; allocation?: CapacityAllocation } = {},
): CapacityReport {
  const now = options.now ?? new Date();
  const allocation = options.allocation ?? resolveCapacityAllocation(projectRoot);
  const vbriefRoot = join(projectRoot, "vbrief");

  const records = iterVbriefPlans(vbriefRoot).map(({ folder, plan }) =>
    classifyRecord(plan, folder, allocation, now),
  );

  const tallies = new Map<string, BucketTally>();
  for (const bucket of allocation.buckets) {
    tallies.set(bucket.bucketId, {
      bucketId: bucket.bucketId,
      target: bucket.target,
      forwardWeight: 0,
      backwardWeight: 0,
      reworkWeight: 0,
      costActual: null,
    });
  }
  for (const record of records) {
    if (!tallies.has(record.bucket)) {
      tallies.set(record.bucket, {
        bucketId: record.bucket,
        target: 0,
        forwardWeight: 0,
        backwardWeight: 0,
        reworkWeight: 0,
        costActual: null,
      });
    }
  }

  let classifiedCompletions = 0;
  let unclassifiedCompletions = 0;
  let costEligible = 0;
  let costWithActual = 0;

  for (const record of records) {
    const tally = tallies.get(record.bucket);
    if (!tally) continue;
    if ((FORWARD_FOLDERS as readonly string[]).includes(record.folder)) {
      tally.forwardWeight += record.weight;
    } else if (record.folder === BACKWARD_FOLDER && record.inWindow) {
      tally.backwardWeight += record.weight;
      if (record.isRework) tally.reworkWeight += record.weight;
      if (record.classified) {
        classifiedCompletions += 1;
        costEligible += 1;
        if (record.cost !== null) {
          costWithActual += 1;
          tally.costActual = (tally.costActual ?? 0) + record.cost;
        }
      }
    }
    if (
      record.folder === BACKWARD_FOLDER &&
      !record.classified &&
      (record.inWindow || !record.completedAtPresent)
    ) {
      unclassifiedCompletions += 1;
    }
  }

  const totalForward = [...tallies.values()].reduce((s, t) => s + t.forwardWeight, 0);
  const totalBackward = [...tallies.values()].reduce((s, t) => s + t.backwardWeight, 0);
  const totalRework = [...tallies.values()].reduce((s, t) => s + t.reworkWeight, 0);

  const configuredIds = allocation.buckets.map((b: CapacityBucket) => b.bucketId);
  const extras = [...tallies.keys()].filter((id) => !configuredIds.includes(id)).sort();
  const ordered = [
    ...configuredIds.map((id) => tallies.get(id) as BucketTally),
    ...extras.map((id) => tallies.get(id) as BucketTally),
  ];

  const unitRequested = [DEFAULT_CAPACITY_UNIT, CAPACITY_UNIT_COST].includes(allocation.unit)
    ? allocation.unit
    : DEFAULT_CAPACITY_UNIT;
  const [unitEffective, costFallback, costReason] = resolveEffectiveUnit(
    unitRequested,
    costEligible,
    costWithActual,
  );

  const advisoryReasons: string[] = [];
  if (!allocation.configured) {
    advisoryReasons.push("capacityAllocation not configured -- showing discovered buckets only");
  }
  const sampleShort = classifiedCompletions < allocation.minSampleSize;
  if (sampleShort) {
    advisoryReasons.push(
      `only ${classifiedCompletions} classified completion(s) in window ` +
        `(< minSampleSize=${allocation.minSampleSize}) -- deferring to ordering`,
    );
    if (allocation.configured && unclassifiedCompletions > 0) {
      advisoryReasons.push(
        `${unclassifiedCompletions} completed vBRIEF(s) are unclassified ` +
          "-- run `task capacity:backfill --apply` (one-time) to classify " +
          "history and activate capacity accounting",
      );
    }
  }
  if (costFallback && costReason) advisoryReasons.push(costReason);

  const backlog = summarizeDecisionBacklog(projectRoot, {
    now,
    windowDays: allocation.windowDays,
  });
  const reworkRate = totalBackward > 0 ? totalRework / totalBackward : 0;
  const autonomyPolicy = resolveAutonomy(projectRoot);
  const autonomy = autonomyPolicy.enabled
    ? recommendAutonomyLevel(autonomyPolicy.defaultLevel, {
        overrideRate: backlog.overrideRate,
        reworkRate,
        sampleSize: backlog.resolvedInWindow,
        p0Reversal: backlog.p0ReversalInWindow,
        policy: autonomyPolicy,
      })
    : null;

  return {
    configured: allocation.configured,
    source: allocation.source,
    unitRequested,
    unitEffective,
    costFallback,
    costFallbackReason: costReason,
    windowDays: allocation.windowDays,
    minSampleSize: allocation.minSampleSize,
    classifiedCompletions,
    unclassifiedCompletions,
    advisoryMode: sampleShort || !allocation.configured,
    advisoryReasons,
    buckets: ordered,
    totalForward,
    totalBackward,
    policyError: allocation.error,
    pendingDecisions: backlog.pendingCount,
    pendingDecisionsThreshold: DEFAULT_PENDING_DECISIONS_THRESHOLD,
    pendingByKind: backlog.byKind,
    pendingNudge: pendingDecisionsNudgeLine(backlog.pendingCount),
    autonomyEnabled: autonomyPolicy.enabled,
    autonomy,
  };
}

function formatCost(value: number | null): string {
  if (value === null) return "none/estimate-only";
  return value.toFixed(2);
}

function appendBacklogAndAutonomy(lines: string[], report: CapacityReport): void {
  lines.push(
    `  Pending human decisions: ${report.pendingDecisions} ` +
      `(threshold ${report.pendingDecisionsThreshold})`,
  );
  const kinds = Object.entries(report.pendingByKind).sort(([a], [b]) => a.localeCompare(b));
  if (kinds.length > 0) {
    lines.push(`    by kind: ${kinds.map(([k, c]) => `${k}=${c}`).join(", ")}`);
  }
  if (report.pendingNudge) lines.push(`  ${report.pendingNudge}`);
  if (report.autonomyEnabled && report.autonomy !== null) {
    const rec = report.autonomy;
    lines.push(
      `  Autonomy dial (advisory-only): ${rec.currentLevel} -> ` +
        `${rec.recommendedLevel} [${rec.action}]`,
    );
    lines.push(`    ${rec.rationale}`);
  }
}

export function renderReport(report: CapacityReport): string {
  const lines: string[] = [];
  lines.push("Capacity allocation (advisory, offline / filesystem-truth)");
  lines.push(
    `  unit: ${report.unitEffective}` +
      (report.costFallback ? ` (requested ${report.unitRequested}; cost fallback active)` : ""),
  );
  lines.push(
    `  window: trailing ${report.windowDays}d | ` +
      `classified completions: ${report.classifiedCompletions} ` +
      `(minSampleSize ${report.minSampleSize}) | source: ${report.source}`,
  );
  if (report.policyError) lines.push(`  CONFIG ERROR: ${report.policyError}`);

  if (report.advisoryMode) {
    lines.push("  MODE: ADVISORY -- deferring to selection ordering.");
  }
  for (const reason of report.advisoryReasons) {
    lines.push(`    - ${reason}`);
  }

  appendBacklogAndAutonomy(lines, report);

  if (report.buckets.length === 0) {
    lines.push("  (no buckets configured and no classified work on disk)");
    return lines.join("\n");
  }

  const header = `  ${"bucket".padEnd(16)} ${"target".padStart(7)} ${"fwd".padStart(7)} ${"back".padStart(7)} ${"deficit".padStart(8)} ${"rework".padStart(7)} ${"cost".padStart(18)}`;
  lines.push(header);
  lines.push(`  ${"-".repeat(header.length - 2)}`);
  for (const tally of report.buckets) {
    const deficit = bucketDeficit(report, tally);
    const deficitStr = deficit >= 0 ? `+${deficit.toFixed(2)}` : deficit.toFixed(2);
    lines.push(
      `  ${tally.bucketId.padEnd(16)} ` +
        `${(tally.target * 100).toFixed(1).padStart(6)}% ` +
        `${tally.forwardWeight.toFixed(1).padStart(7)} ` +
        `${tally.backwardWeight.toFixed(1).padStart(7)} ` +
        `${deficitStr.padStart(8)} ` +
        `${tally.reworkWeight.toFixed(1).padStart(7)} ` +
        `${formatCost(tally.costActual).padStart(18)}`,
    );
  }
  lines.push(
    `  ${"TOTAL".padEnd(16)} ${"".padStart(7)} ${report.totalForward.toFixed(1).padStart(7)} ` +
      `${report.totalBackward.toFixed(1).padStart(7)}`,
  );
  if (report.costFallback) {
    lines.push(
      "  Note: cost overlay shows none/estimate-only -- no grounded cost " +
        "telemetry (out of scope / upstream-blocked, OQ2).",
    );
  }
  return lines.join("\n");
}
