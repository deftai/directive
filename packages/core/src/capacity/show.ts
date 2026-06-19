import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { recommendAutonomyLevel, resolveAutonomy } from "../policy/autonomy.js";
import {
  CAPACITY_UNIT_COST,
  type CapacityAllocation,
  DEFAULT_CAPACITY_UNIT,
  resolveCapacityAllocation,
} from "../policy/capacity.js";
import {
  DEFAULT_PENDING_DECISIONS_THRESHOLD,
  pendingDecisionsNudgeLine,
  summarizeDecisionBacklog,
} from "../policy/decisions.js";

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
  readonly in_window: boolean;
  readonly completed_at_present: boolean;
  readonly is_rework: boolean;
  readonly cost: number | null;
}

export interface BucketTally {
  bucket_id: string;
  target: number;
  forward_weight: number;
  backward_weight: number;
  rework_weight: number;
  cost_actual: number | null;
}

export interface CapacityReport {
  configured: boolean;
  source: string;
  unit_requested: string;
  unit_effective: string;
  cost_fallback: boolean;
  cost_fallback_reason: string | null;
  window_days: number;
  min_sample_size: number;
  classified_completions: number;
  unclassified_completions: number;
  advisory_mode: boolean;
  advisory_reasons: string[];
  buckets: BucketTally[];
  total_forward: number;
  total_backward: number;
  policy_error: string | null;
  pending_decisions: number;
  pending_decisions_threshold: number;
  pending_by_kind: Record<string, number>;
  pending_nudge: string;
  autonomy_enabled: boolean;
  autonomy: ReturnType<typeof recommendAutonomyLevel> | null;
}

function parseIso(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parsed = new Date(value.replace("Z", "+00:00"));
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function planHasChildren(plan: Record<string, unknown>): boolean {
  const refs = plan.references;
  if (!Array.isArray(refs)) {
    return false;
  }
  return refs.some(
    (ref) =>
      typeof ref === "object" &&
      ref !== null &&
      (ref as Record<string, unknown>).type === "x-vbrief/plan",
  );
}

function coerceCost(value: unknown): number | null {
  if (typeof value === "boolean") {
    return null;
  }
  if (typeof value === "number" && value > 0) {
    return value;
  }
  return null;
}

function recordWeight(
  kind: string,
  plan: Record<string, unknown>,
  metadata: Record<string, unknown>,
  allocation: CapacityAllocation,
): number {
  if (PARENT_KINDS.has(kind)) {
    if (planHasChildren(plan)) {
      return 0;
    }
    const estimated = metadata.estimatedChildren;
    if (typeof estimated === "number" && Number.isInteger(estimated) && estimated > 0) {
      return estimated;
    }
    return allocation.default_epic_estimate;
  }
  return 1;
}

/** Derive a VbriefRecord from a single vBRIEF plan block. */
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
  const kind = typeof kindRaw === "string" && kindRaw.length > 0 ? kindRaw : "story";

  const explicitBucket = metadata.capacityBucket;
  const classified = typeof explicitBucket === "string" && explicitBucket.trim().length > 0;
  let bucket: string;
  if (classified) {
    bucket = explicitBucket.trim();
  } else if (allocation.default_bucket) {
    bucket = allocation.default_bucket;
  } else {
    bucket = UNASSIGNED_BUCKET;
  }

  const weight = recordWeight(kind, plan, metadata, allocation);

  let inWindow = false;
  const rawCompletedAt = metadata.completedAt;
  const completedAtPresent = typeof rawCompletedAt === "string" && rawCompletedAt.trim().length > 0;
  if (folder === BACKWARD_FOLDER) {
    const completedAt = parseIso(rawCompletedAt);
    if (completedAt !== null) {
      const ageDays = (now.getTime() - completedAt.getTime()) / (86400 * 1000);
      inWindow = ageDays >= 0 && ageDays <= allocation.window_days;
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
    in_window: inWindow,
    completed_at_present: completedAtPresent,
    is_rework: isRework,
    cost: coerceCost(metadata.cost),
  };
}

/** Yield (folder, plan) for every readable vBRIEF in lifecycle dirs. */
export function iterVbriefPlans(vbriefRoot: string): [string, Record<string, unknown>][] {
  const out: [string, Record<string, unknown>][] = [];
  for (const folder of [...FORWARD_FOLDERS, BACKWARD_FOLDER]) {
    const folderPath = join(vbriefRoot, folder);
    if (!existsSync(folderPath)) {
      continue;
    }
    let names: string[];
    try {
      names = readdirSync(folderPath);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!name.endsWith(".vbrief.json")) {
        continue;
      }
      const child = join(folderPath, name);
      try {
        const data = JSON.parse(readFileSync(child, { encoding: "utf8" })) as unknown;
        const plan =
          typeof data === "object" && data !== null && !Array.isArray(data)
            ? (data as Record<string, unknown>).plan
            : null;
        if (typeof plan === "object" && plan !== null && !Array.isArray(plan)) {
          out.push([folder, plan as Record<string, unknown>]);
        }
      } catch {
        // skip unreadable
      }
    }
  }
  return out;
}

export function bucketDeficit(report: CapacityReport, tally: BucketTally): number {
  const targetWeight = tally.target * report.total_backward;
  return Math.round((targetWeight - tally.backward_weight) * 10000) / 10000;
}

function resolveEffectiveUnit(
  unitRequested: string,
  costEligible: number,
  costWithActual: number,
): [string, boolean, string | null] {
  if (unitRequested !== CAPACITY_UNIT_COST) {
    return [unitRequested, false, null];
  }
  if (costEligible === 0) {
    return [
      DEFAULT_CAPACITY_UNIT,
      true,
      "unit:cost requested but no classified completions carry grounded cost actuals -- falling back to advisory vbrief-count (cost overlay: none/estimate-only)",
    ];
  }
  const coverage = costWithActual / costEligible;
  if (coverage < COST_COVERAGE_FLOOR) {
    return [
      DEFAULT_CAPACITY_UNIT,
      true,
      `unit:cost requested but only ${costWithActual}/${costEligible} (${Math.round(coverage * 100)}%) classified completions carry grounded cost actuals (< ${Math.round(COST_COVERAGE_FLOOR * 100)}% floor) -- falling back to advisory vbrief-count (cost overlay: none/estimate-only)`,
    ];
  }
  return [CAPACITY_UNIT_COST, false, null];
}

/** Compute the CapacityReport for project_root (offline). */
export function computeReport(
  projectRoot: string,
  options: { now?: Date; allocation?: CapacityAllocation } = {},
): CapacityReport {
  const now = options.now ?? new Date();
  const allocation = options.allocation ?? resolveCapacityAllocation(projectRoot);
  const vbriefRoot = join(resolve(projectRoot), "vbrief");

  const records = iterVbriefPlans(vbriefRoot).map(([folder, plan]) =>
    classifyRecord(plan, folder, allocation, now),
  );

  const tallies = new Map<string, BucketTally>();
  for (const bucket of allocation.buckets) {
    tallies.set(bucket.bucket_id, {
      bucket_id: bucket.bucket_id,
      target: bucket.target,
      forward_weight: 0,
      backward_weight: 0,
      rework_weight: 0,
      cost_actual: null,
    });
  }
  for (const record of records) {
    if (!tallies.has(record.bucket)) {
      tallies.set(record.bucket, {
        bucket_id: record.bucket,
        target: 0,
        forward_weight: 0,
        backward_weight: 0,
        rework_weight: 0,
        cost_actual: null,
      });
    }
  }

  let classifiedCompletions = 0;
  let unclassifiedCompletions = 0;
  let costEligible = 0;
  let costWithActual = 0;

  for (const record of records) {
    const tally = tallies.get(record.bucket);
    if (tally === undefined) {
      continue;
    }
    if ((FORWARD_FOLDERS as readonly string[]).includes(record.folder)) {
      tally.forward_weight += record.weight;
    } else if (record.folder === BACKWARD_FOLDER && record.in_window) {
      tally.backward_weight += record.weight;
      if (record.is_rework) {
        tally.rework_weight += record.weight;
      }
      if (record.classified) {
        classifiedCompletions += 1;
        costEligible += 1;
        if (record.cost !== null) {
          costWithActual += 1;
          tally.cost_actual = (tally.cost_actual ?? 0) + record.cost;
        }
      }
    }
  }

  unclassifiedCompletions = records.filter(
    (record) =>
      record.folder === BACKWARD_FOLDER &&
      !record.classified &&
      (record.in_window || !record.completed_at_present),
  ).length;

  const totalForward = [...tallies.values()].reduce((sum, t) => sum + t.forward_weight, 0);
  const totalBackward = [...tallies.values()].reduce((sum, t) => sum + t.backward_weight, 0);
  const totalRework = [...tallies.values()].reduce((sum, t) => sum + t.rework_weight, 0);

  const configuredIds = allocation.buckets.map((b) => b.bucket_id);
  const extras = [...tallies.keys()].filter((id) => !configuredIds.includes(id)).sort();
  const ordered = [...configuredIds, ...extras].map((id) => tallies.get(id) as BucketTally);

  const unitRequested =
    allocation.unit === DEFAULT_CAPACITY_UNIT || allocation.unit === CAPACITY_UNIT_COST
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
  const sampleShort = classifiedCompletions < allocation.min_sample_size;
  if (sampleShort) {
    advisoryReasons.push(
      `only ${classifiedCompletions} classified completion(s) in window (< minSampleSize=${allocation.min_sample_size}) -- deferring to ordering`,
    );
    if (allocation.configured && unclassifiedCompletions > 0) {
      advisoryReasons.push(
        `${unclassifiedCompletions} completed vBRIEF(s) are unclassified -- run \`task capacity:backfill --apply\` (one-time) to classify history and activate capacity accounting`,
      );
    }
  }
  if (costFallback && costReason) {
    advisoryReasons.push(costReason);
  }

  const backlog = summarizeDecisionBacklog(projectRoot, {
    now,
    window_days: allocation.window_days,
  });
  const reworkRate = totalBackward > 0 ? totalRework / totalBackward : 0;
  const autonomyPolicy = resolveAutonomy(projectRoot);
  const autonomy = autonomyPolicy.enabled
    ? recommendAutonomyLevel(autonomyPolicy.default_level, {
        override_rate: backlog.override_rate,
        rework_rate: reworkRate,
        sample_size: backlog.resolved_in_window,
        p0_reversal: backlog.p0_reversal_in_window,
        policy: autonomyPolicy,
      })
    : null;

  return {
    configured: allocation.configured,
    source: allocation.source,
    unit_requested: unitRequested,
    unit_effective: unitEffective,
    cost_fallback: costFallback,
    cost_fallback_reason: costReason,
    window_days: allocation.window_days,
    min_sample_size: allocation.min_sample_size,
    classified_completions: classifiedCompletions,
    unclassified_completions: unclassifiedCompletions,
    advisory_mode: sampleShort || !allocation.configured,
    advisory_reasons: advisoryReasons,
    buckets: ordered,
    total_forward: totalForward,
    total_backward: totalBackward,
    policy_error: allocation.error,
    pending_decisions: backlog.pending_count,
    pending_by_kind: { ...backlog.by_kind },
    pending_decisions_threshold: DEFAULT_PENDING_DECISIONS_THRESHOLD,
    pending_nudge: pendingDecisionsNudgeLine(backlog.pending_count),
    autonomy_enabled: autonomyPolicy.enabled,
    autonomy,
  };
}

function formatCost(value: number | null): string {
  if (value === null) {
    return "none/estimate-only";
  }
  return value.toFixed(2);
}

function appendBacklogAndAutonomy(lines: string[], report: CapacityReport): void {
  lines.push(
    `  Pending human decisions: ${report.pending_decisions} (threshold ${report.pending_decisions_threshold})`,
  );
  if (Object.keys(report.pending_by_kind).length > 0) {
    const kinds = Object.entries(report.pending_by_kind)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([kind, count]) => `${kind}=${count}`)
      .join(", ");
    lines.push(`    by kind: ${kinds}`);
  }
  if (report.pending_nudge.length > 0) {
    lines.push(`  ${report.pending_nudge}`);
  }
  if (report.autonomy_enabled && report.autonomy !== null) {
    const rec = report.autonomy;
    lines.push(
      `  Autonomy dial (advisory-only): ${rec.current_level} -> ${rec.recommended_level} [${rec.action}]`,
    );
    lines.push(`    ${rec.rationale}`);
  }
}

/** Render the CapacityReport as human-readable text. */
export function renderReport(report: CapacityReport): string {
  const lines: string[] = [];
  lines.push("Capacity allocation (advisory, offline / filesystem-truth)");
  lines.push(
    `  unit: ${report.unit_effective}` +
      (report.cost_fallback ? ` (requested ${report.unit_requested}; cost fallback active)` : ""),
  );
  lines.push(
    `  window: trailing ${report.window_days}d | classified completions: ${report.classified_completions} (minSampleSize ${report.min_sample_size}) | source: ${report.source}`,
  );
  if (report.policy_error) {
    lines.push(`  CONFIG ERROR: ${report.policy_error}`);
  }
  if (report.advisory_mode) {
    lines.push("  MODE: ADVISORY -- deferring to selection ordering.");
  }
  for (const reason of report.advisory_reasons) {
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
    lines.push(
      `  ${tally.bucket_id.padEnd(16)} ${`${(tally.target * 100).toFixed(1)}%`.padStart(7)} ${tally.forward_weight.toFixed(1).padStart(7)} ${tally.backward_weight.toFixed(1).padStart(7)} ${`${deficit >= 0 ? "+" : ""}${deficit.toFixed(2)}`.padStart(8)} ${tally.rework_weight.toFixed(1).padStart(7)} ${formatCost(tally.cost_actual).padStart(18)}`,
    );
  }
  lines.push(
    `  ${"TOTAL".padEnd(16)} ${"".padStart(7)} ${report.total_forward.toFixed(1).padStart(7)} ${report.total_backward.toFixed(1).padStart(7)}`,
  );
  if (report.cost_fallback) {
    lines.push(
      "  Note: cost overlay shows none/estimate-only -- no grounded cost telemetry (out of scope / upstream-blocked, OQ2).",
    );
  }
  return lines.join("\n");
}

/** Pure entry point: returns [exit_code, report, rendered_text]. */
export function evaluate(
  projectRoot: string,
  options: { now?: Date } = {},
): [number, CapacityReport | null, string] {
  const root = resolve(projectRoot);
  try {
    if (!statSync(root).isDirectory()) {
      return [
        2,
        null,
        `capacity_show: --project-root is not a directory: ${root}\n  Recovery: pass an existing project root.`,
      ];
    }
  } catch {
    return [
      2,
      null,
      `capacity_show: --project-root is not a directory: ${root}\n  Recovery: pass an existing project root.`,
    ];
  }
  const report = computeReport(root, options);
  return [0, report, renderReport(report)];
}

export interface CapacityShowCliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** CLI entry point. */
export function runCapacityShowCli(argv: string[]): CapacityShowCliResult {
  let projectRoot = ".";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          exitCode: 2,
          stdout: "",
          stderr: "argument --project-root: expected one argument\n",
        };
      }
      projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    }
  }
  const [code, _report, message] = evaluate(projectRoot);
  if (code === 0) {
    return { exitCode: 0, stdout: `${message}\n`, stderr: "" };
  }
  return { exitCode: code, stdout: "", stderr: `${message}\n` };
}
