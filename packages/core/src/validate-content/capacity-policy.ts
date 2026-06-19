import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProjectDefinition } from "../policy/resolve.js";

export const DEFAULT_CAPACITY_UNIT = "vbrief-count";
export const CAPACITY_UNIT_COST = "cost";
export const CAPACITY_UNITS = new Set([DEFAULT_CAPACITY_UNIT, CAPACITY_UNIT_COST]);
export const DEFAULT_CAPACITY_WINDOW_DAYS = 30;
export const DEFAULT_CAPACITY_ENFORCEMENT = "advise";
export const CAPACITY_ENFORCEMENTS = new Set(["advise", "enforce"]);
export const DEFAULT_CAPACITY_MIN_SAMPLE_SIZE = 20;
export const DEFAULT_EPIC_ESTIMATE = 3;
export const DEFAULT_EPIC_STALENESS_DAYS = 30;
export const CAPACITY_TARGET_SUM_TOLERANCE = 1e-6;
export const DEFAULT_PENDING_DECISIONS_THRESHOLD = 5;

export const AUTONOMY_LEVELS = ["observe", "escalate", "execute"] as const;
export const DEFAULT_AUTONOMY_LEVEL = "escalate";
export const AUTONOMY_ACTION_HOLD = "hold";
export const DEFAULT_AUTONOMY_ADVANCE_OVERRIDE_MAX = 0.05;
export const DEFAULT_AUTONOMY_RETREAT_OVERRIDE_RATE = 0.2;
export const DEFAULT_AUTONOMY_REWORK_BASELINE = 0.15;
export const DEFAULT_AUTONOMY_MIN_SAMPLE_SIZE = 20;

export interface CapacityBucket {
  readonly bucketId: string;
  readonly target: number;
}

export interface CapacityAllocation {
  readonly unit: string;
  readonly windowDays: number;
  readonly enforcement: string;
  readonly minSampleSize: number;
  readonly buckets: readonly CapacityBucket[];
  readonly defaultBucket: string;
  readonly defaultEpicEstimate: number;
  readonly epicStalenessDays: number;
  readonly source: "typed" | "default" | "default-on-error";
  readonly error: string | null;
  readonly configured: boolean;
}

export interface AutonomyPolicy {
  readonly enabled: boolean;
  readonly defaultLevel: string;
  readonly minSampleSize: number;
  readonly advanceOverrideMax: number;
  readonly retreatOverrideRate: number;
  readonly reworkBaseline: number;
  readonly gateLevels: Readonly<Record<string, string>>;
  readonly source: string;
  readonly error: string | null;
}

export interface AutonomyRecommendation {
  readonly currentLevel: string;
  readonly recommendedLevel: string;
  readonly action: string;
  readonly rationale: string;
  readonly gateId: string | null;
}

export interface DecisionBacklog {
  readonly pendingCount: number;
  readonly byKind: Readonly<Record<string, number>>;
  readonly resolvedInWindow: number;
  readonly overrideCount: number;
  readonly p0ReversalInWindow: boolean;
  readonly overrideRate: number;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && !Number.isNaN(value) && typeof value !== "boolean";
}

function isPositiveInt(value: unknown): boolean {
  return (
    typeof value === "number" && Number.isInteger(value) && value > 0 && typeof value !== "boolean"
  );
}

function defaultCapacityAllocation(
  source: CapacityAllocation["source"],
  error: string | null = null,
): CapacityAllocation {
  return {
    unit: DEFAULT_CAPACITY_UNIT,
    windowDays: DEFAULT_CAPACITY_WINDOW_DAYS,
    enforcement: DEFAULT_CAPACITY_ENFORCEMENT,
    minSampleSize: DEFAULT_CAPACITY_MIN_SAMPLE_SIZE,
    buckets: [],
    defaultBucket: "",
    defaultEpicEstimate: DEFAULT_EPIC_ESTIMATE,
    epicStalenessDays: DEFAULT_EPIC_STALENESS_DAYS,
    source,
    error,
    configured: false,
  };
}

export function validateCapacityAllocation(value: unknown): string[] {
  const errors: string[] = [];
  if (value === null || value === undefined) return errors;
  if (typeof value !== "object" || Array.isArray(value)) {
    errors.push(
      `plan.policy.capacityAllocation must be an object; got ${typeof value} (${JSON.stringify(value)})`,
    );
    return errors;
  }
  const obj = value as Record<string, unknown>;

  const unit = obj.unit ?? DEFAULT_CAPACITY_UNIT;
  if (!CAPACITY_UNITS.has(String(unit))) {
    errors.push(
      `plan.policy.capacityAllocation.unit must be one of ${JSON.stringify([...CAPACITY_UNITS].sort())}; got ${JSON.stringify(unit)}`,
    );
  }

  const enforcement = obj.enforcement ?? DEFAULT_CAPACITY_ENFORCEMENT;
  if (!CAPACITY_ENFORCEMENTS.has(String(enforcement))) {
    errors.push(
      `plan.policy.capacityAllocation.enforcement must be one of ${JSON.stringify([...CAPACITY_ENFORCEMENTS].sort())}; got ${JSON.stringify(enforcement)}`,
    );
  }

  if (!("window" in obj)) {
    errors.push(
      "plan.policy.capacityAllocation.window is required (trailing accounting window in days)",
    );
  } else if (!isPositiveInt(obj.window)) {
    errors.push(
      `plan.policy.capacityAllocation.window must be a positive integer (days); got ${JSON.stringify(obj.window)}`,
    );
  }

  if ("minSampleSize" in obj) {
    const mss = obj.minSampleSize;
    if (typeof mss !== "number" || !Number.isInteger(mss) || mss < 0 || typeof mss === "boolean") {
      errors.push(
        `plan.policy.capacityAllocation.minSampleSize must be a non-negative integer; got ${JSON.stringify(mss)}`,
      );
    }
  }

  if ("defaultEpicEstimate" in obj && !isPositiveInt(obj.defaultEpicEstimate)) {
    errors.push(
      `plan.policy.capacityAllocation.defaultEpicEstimate must be a positive integer; got ${JSON.stringify(obj.defaultEpicEstimate)}`,
    );
  }

  if ("epicStalenessDays" in obj && !isPositiveInt(obj.epicStalenessDays)) {
    errors.push(
      `plan.policy.capacityAllocation.epicStalenessDays must be a positive integer; got ${JSON.stringify(obj.epicStalenessDays)}`,
    );
  }

  errors.push(...validateCapacityBuckets(obj));
  return errors;
}

function validateCapacityBuckets(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const buckets = value.buckets;
  if (!Array.isArray(buckets) || buckets.length === 0) {
    errors.push("plan.policy.capacityAllocation.buckets must be a non-empty array");
    return errors;
  }

  const ids: string[] = [];
  let total = 0;
  for (let idx = 0; idx < buckets.length; idx += 1) {
    const bucket = buckets[idx];
    if (typeof bucket !== "object" || bucket === null || Array.isArray(bucket)) {
      errors.push(`plan.policy.capacityAllocation.buckets[${idx}] must be an object`);
      continue;
    }
    const b = bucket as Record<string, unknown>;
    const bucketId = b.id;
    if (typeof bucketId !== "string" || !bucketId.trim()) {
      errors.push(`plan.policy.capacityAllocation.buckets[${idx}].id must be a non-empty string`);
    } else {
      ids.push(bucketId);
    }
    const target = b.target;
    if (!isNumber(target)) {
      errors.push(
        `plan.policy.capacityAllocation.buckets[${idx}].target must be a number; got ${JSON.stringify(target)}`,
      );
    } else if (target < 0 || target > 1) {
      errors.push(
        `plan.policy.capacityAllocation.buckets[${idx}].target must be between 0.0 and 1.0; got ${JSON.stringify(target)}`,
      );
    } else {
      total += target;
    }
  }

  const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))].sort();
  if (duplicates.length > 0) {
    errors.push(
      `plan.policy.capacityAllocation.buckets ids must be unique; duplicates: ${JSON.stringify(duplicates)}`,
    );
  }

  if (ids.length > 0 && Math.abs(total - 1.0) > CAPACITY_TARGET_SUM_TOLERANCE) {
    errors.push(
      `plan.policy.capacityAllocation.buckets targets must sum to 1.0; got ${total.toFixed(6)}`,
    );
  }

  const defaultBucket = value.defaultBucket;
  if (defaultBucket !== undefined && defaultBucket !== null) {
    if (typeof defaultBucket !== "string") {
      errors.push("plan.policy.capacityAllocation.defaultBucket must be a string");
    } else if (!ids.includes(defaultBucket)) {
      errors.push(
        `plan.policy.capacityAllocation.defaultBucket ${JSON.stringify(defaultBucket)} must match a declared bucket id`,
      );
    }
  }

  return errors;
}

export function resolveCapacityAllocation(projectRoot: string): CapacityAllocation {
  const [data, err] = loadProjectDefinition(projectRoot);
  if (data === null) {
    return defaultCapacityAllocation("default", err);
  }

  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return defaultCapacityAllocation("default");
  }
  const policy = (plan as Record<string, unknown>).policy;
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    return defaultCapacityAllocation("default");
  }
  const policyBlock = policy as Record<string, unknown>;
  if (!("capacityAllocation" in policyBlock)) {
    return defaultCapacityAllocation("default");
  }

  const raw = policyBlock.capacityAllocation;
  const validationErrors = validateCapacityAllocation(raw);
  if (
    validationErrors.length > 0 ||
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw)
  ) {
    return defaultCapacityAllocation(
      "default-on-error",
      validationErrors[0] ?? "capacityAllocation must be an object",
    );
  }

  const obj = raw as Record<string, unknown>;
  const bucketsRaw = obj.buckets as unknown[];
  const buckets: CapacityBucket[] = bucketsRaw.map((bucket) => {
    const b = bucket as Record<string, unknown>;
    return { bucketId: String(b.id), target: Number(b.target) };
  });

  const defaultBucket = obj.defaultBucket;
  return {
    unit: String(obj.unit ?? DEFAULT_CAPACITY_UNIT),
    windowDays: Number(obj.window),
    enforcement: String(obj.enforcement ?? DEFAULT_CAPACITY_ENFORCEMENT),
    minSampleSize: Number(obj.minSampleSize ?? DEFAULT_CAPACITY_MIN_SAMPLE_SIZE),
    buckets,
    defaultBucket: typeof defaultBucket === "string" ? defaultBucket : "",
    defaultEpicEstimate: Number(obj.defaultEpicEstimate ?? DEFAULT_EPIC_ESTIMATE),
    epicStalenessDays: Number(obj.epicStalenessDays ?? DEFAULT_EPIC_STALENESS_DAYS),
    source: "typed",
    error: null,
    configured: buckets.length > 0,
  };
}

function defaultAutonomyPolicy(source: string, error: string | null = null): AutonomyPolicy {
  return {
    enabled: true,
    defaultLevel: DEFAULT_AUTONOMY_LEVEL,
    minSampleSize: DEFAULT_AUTONOMY_MIN_SAMPLE_SIZE,
    advanceOverrideMax: DEFAULT_AUTONOMY_ADVANCE_OVERRIDE_MAX,
    retreatOverrideRate: DEFAULT_AUTONOMY_RETREAT_OVERRIDE_RATE,
    reworkBaseline: DEFAULT_AUTONOMY_REWORK_BASELINE,
    gateLevels: {},
    source,
    error,
  };
}

export function resolveAutonomy(projectRoot: string): AutonomyPolicy {
  const [data, err] = loadProjectDefinition(projectRoot);
  if (data === null) return defaultAutonomyPolicy("default", err);

  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return defaultAutonomyPolicy("default");
  }
  const policy = (plan as Record<string, unknown>).policy;
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    return defaultAutonomyPolicy("default");
  }
  if (!("autonomy" in (policy as Record<string, unknown>))) {
    return defaultAutonomyPolicy("default");
  }

  const raw = (policy as Record<string, unknown>).autonomy;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return defaultAutonomyPolicy("default-on-error", "autonomy must be an object");
  }

  const obj = raw as Record<string, unknown>;
  const gateLevels: Record<string, string> = {};
  const gates = obj.gates;
  if (typeof gates === "object" && gates !== null && !Array.isArray(gates)) {
    for (const [gid, level] of Object.entries(gates)) {
      if (typeof level === "string") gateLevels[gid] = level;
    }
  }

  return {
    enabled: obj.enabled !== false,
    defaultLevel: String(obj.defaultLevel ?? DEFAULT_AUTONOMY_LEVEL),
    minSampleSize: Number(obj.minSampleSize ?? DEFAULT_AUTONOMY_MIN_SAMPLE_SIZE),
    advanceOverrideMax: Number(obj.advanceOverrideMax ?? DEFAULT_AUTONOMY_ADVANCE_OVERRIDE_MAX),
    retreatOverrideRate: Number(obj.retreatOverrideRate ?? DEFAULT_AUTONOMY_RETREAT_OVERRIDE_RATE),
    reworkBaseline: Number(obj.reworkBaseline ?? DEFAULT_AUTONOMY_REWORK_BASELINE),
    gateLevels,
    source: "typed",
    error: null,
  };
}

function parseIsoTs(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = new Date(value.replace("Z", "+00:00"));
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readDecisionEvents(projectRoot: string): Record<string, unknown>[] {
  const path = join(projectRoot, "vbrief", ".audit", "pending-human-decisions.jsonl");
  if (!existsSync(path)) return [];
  const out: Record<string, unknown>[] = [];
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as unknown;
      if (
        typeof obj === "object" &&
        obj !== null &&
        typeof (obj as Record<string, unknown>).decision_id === "string"
      ) {
        out.push(obj as Record<string, unknown>);
      }
    } catch {
      // skip malformed
    }
  }
  return out;
}

export function summarizeDecisionBacklog(
  projectRoot: string,
  options: { now?: Date; windowDays?: number; events?: Record<string, unknown>[] } = {},
): DecisionBacklog {
  const records = options.events ?? readDecisionEvents(projectRoot);
  const latest = new Map<string, Record<string, unknown>>();
  for (const event of records) {
    const decisionId = event.decision_id;
    if (typeof decisionId === "string" && decisionId) {
      latest.set(decisionId, event);
    }
  }

  const byKind: Record<string, number> = {};
  let pendingCount = 0;
  for (const event of latest.values()) {
    if (event.status === "pending") {
      pendingCount += 1;
      const kind = typeof event.kind === "string" ? event.kind : "unspecified";
      byKind[kind] = (byKind[kind] ?? 0) + 1;
    }
  }

  const nowDt = options.now ?? new Date();
  let resolvedInWindow = 0;
  let overrideCount = 0;
  let p0Reversal = false;
  for (const event of latest.values()) {
    if (event.status !== "resolved") continue;
    if (options.windowDays !== undefined) {
      const stamp = parseIsoTs(event.timestamp);
      if (stamp === null) continue;
      const ageDays = (nowDt.getTime() - stamp.getTime()) / 86400000;
      if (ageDays < 0 || ageDays > options.windowDays) continue;
    }
    resolvedInWindow += 1;
    if (event.override === true) overrideCount += 1;
    if (event.p0_reversal === true) p0Reversal = true;
  }

  const overrideRate = resolvedInWindow > 0 ? overrideCount / resolvedInWindow : 0;
  return {
    pendingCount,
    byKind,
    resolvedInWindow,
    overrideCount,
    p0ReversalInWindow: p0Reversal,
    overrideRate,
  };
}

export function pendingDecisionsNudgeLine(
  count: number,
  threshold = DEFAULT_PENDING_DECISIONS_THRESHOLD,
): string {
  if (count <= threshold) return "";
  return (
    `[TIER-1] pending human-clearance backlog: ${count} decision(s) ` +
    `awaiting adjudication (> threshold ${threshold}). Tune wipCap to real ` +
    "review throughput or clear the backlog before dispatching more work."
  );
}

function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

export function recommendAutonomyLevel(
  currentLevel: string,
  options: {
    overrideRate: number;
    reworkRate: number;
    sampleSize: number;
    p0Reversal?: boolean;
    policy?: AutonomyPolicy;
    gateId?: string | null;
  },
): AutonomyRecommendation {
  const pol = options.policy ?? defaultAutonomyPolicy("default");
  const cur = (AUTONOMY_LEVELS as readonly string[]).includes(currentLevel)
    ? currentLevel
    : pol.defaultLevel;
  const idx = AUTONOMY_LEVELS.indexOf(cur as (typeof AUTONOMY_LEVELS)[number]);

  if (options.p0Reversal || options.overrideRate > pol.retreatOverrideRate) {
    const trigger = options.p0Reversal
      ? "P0 reversal observed"
      : `override rate ${formatPercent(options.overrideRate)} > retreat threshold ${formatPercent(pol.retreatOverrideRate)}`;
    if (idx === 0) {
      return {
        currentLevel: cur,
        recommendedLevel: cur,
        action: AUTONOMY_ACTION_HOLD,
        rationale:
          `hold at ${cur}: ${trigger} but already at the most conservative ` +
          "level (Observe). ADVISORY: a human confirms.",
        gateId: options.gateId ?? null,
      };
    }
    const next = AUTONOMY_LEVELS[idx - 1] ?? cur;
    return {
      currentLevel: cur,
      recommendedLevel: next,
      action: "retreat",
      rationale:
        `retreat: ${trigger} -- recommend ${next} ` +
        "(restores required human clearances). ADVISORY: a human confirms.",
      gateId: options.gateId ?? null,
    };
  }

  const advanceOk =
    options.sampleSize >= pol.minSampleSize &&
    options.overrideRate < pol.advanceOverrideMax &&
    options.reworkRate <= pol.reworkBaseline;

  if (advanceOk) {
    const basis =
      `override ${formatPercent(options.overrideRate)} < ${formatPercent(pol.advanceOverrideMax)}, ` +
      `rework ${formatPercent(options.reworkRate)} <= baseline ${formatPercent(pol.reworkBaseline)}, ` +
      `sample ${options.sampleSize} >= ${pol.minSampleSize}`;
    if (idx === AUTONOMY_LEVELS.length - 1) {
      return {
        currentLevel: cur,
        recommendedLevel: cur,
        action: AUTONOMY_ACTION_HOLD,
        rationale:
          `hold at ${cur}: advance criteria met (${basis}) but already at ` +
          "the most permissive level (Execute).",
        gateId: options.gateId ?? null,
      };
    }
    const next = AUTONOMY_LEVELS[idx + 1] ?? cur;
    return {
      currentLevel: cur,
      recommendedLevel: next,
      action: "advance",
      rationale:
        `advance: ${basis} -- recommend ${next} ` +
        "(would reduce required human clearances). ADVISORY: a human " +
        "confirms; no auto-ratchet.",
      gateId: options.gateId ?? null,
    };
  }

  return {
    currentLevel: cur,
    recommendedLevel: cur,
    action: AUTONOMY_ACTION_HOLD,
    rationale:
      `hold at ${cur}: override ${formatPercent(options.overrideRate)}, rework ${formatPercent(options.reworkRate)}, ` +
      `sample ${options.sampleSize} -- advance criteria not met, no retreat trigger.`,
    gateId: options.gateId ?? null,
  };
}

/** Python repr for a string in verify_capacity deficit messages. */
export function pythonStringRepr(value: string): string {
  return `'${value}'`;
}
