import { loadProjectDefinition } from "./resolve.js";

export const AUTONOMY_LEVELS = ["observe", "escalate", "execute"] as const;
export const DEFAULT_AUTONOMY_LEVEL = "escalate";
export const AUTONOMY_ACTION_ADVANCE = "advance";
export const AUTONOMY_ACTION_HOLD = "hold";
export const AUTONOMY_ACTION_RETREAT = "retreat";
export const DEFAULT_AUTONOMY_ADVANCE_OVERRIDE_MAX = 0.05;
export const DEFAULT_AUTONOMY_RETREAT_OVERRIDE_RATE = 0.2;
export const DEFAULT_AUTONOMY_REWORK_BASELINE = 0.15;
export const DEFAULT_AUTONOMY_MIN_SAMPLE_SIZE = 20;

export interface AutonomyPolicy {
  readonly enabled: boolean;
  readonly default_level: string;
  readonly min_sample_size: number;
  readonly advance_override_max: number;
  readonly retreat_override_rate: number;
  readonly rework_baseline: number;
  readonly gate_levels: Readonly<Record<string, string>>;
  readonly source: "typed" | "default" | "default-on-error";
  readonly error: string | null;
  readonly configured: boolean;
}

export interface AutonomyRecommendation {
  readonly current_level: string;
  readonly recommended_level: string;
  readonly action: string;
  readonly rationale: string;
  readonly gate_id: string | null;
  readonly advisory: boolean;
}

function isNumber(value: unknown): boolean {
  return typeof value === "number" && !Number.isNaN(value) && typeof value !== "boolean";
}

function defaultAutonomyPolicy(
  source: AutonomyPolicy["source"],
  error: string | null = null,
): AutonomyPolicy {
  return {
    enabled: true,
    default_level: DEFAULT_AUTONOMY_LEVEL,
    min_sample_size: DEFAULT_AUTONOMY_MIN_SAMPLE_SIZE,
    advance_override_max: DEFAULT_AUTONOMY_ADVANCE_OVERRIDE_MAX,
    retreat_override_rate: DEFAULT_AUTONOMY_RETREAT_OVERRIDE_RATE,
    rework_baseline: DEFAULT_AUTONOMY_REWORK_BASELINE,
    gate_levels: {},
    source,
    error,
    configured: source === "typed",
  };
}

function validateAutonomyGates(gates: unknown): string[] {
  if (typeof gates !== "object" || gates === null || Array.isArray(gates)) {
    return ["plan.policy.autonomy.gates must be an object mapping gate-id -> level"];
  }
  const errors: string[] = [];
  for (const [gid, level] of Object.entries(gates as Record<string, unknown>)) {
    if (typeof gid !== "string" || gid.trim().length === 0) {
      errors.push("plan.policy.autonomy.gates keys must be non-empty gate-id strings");
    }
    if (
      typeof level !== "string" ||
      !AUTONOMY_LEVELS.includes(level as (typeof AUTONOMY_LEVELS)[number])
    ) {
      errors.push(
        `plan.policy.autonomy.gates[${JSON.stringify(gid)}] must be one of ${JSON.stringify([...AUTONOMY_LEVELS].sort())}; got ${String(level)}`,
      );
    }
  }
  return errors;
}

/** Validate a plan.policy.autonomy payload. */
export function validateAutonomy(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return [`plan.policy.autonomy must be an object; got ${typeof value}`];
  }
  const rec = value as Record<string, unknown>;
  const errors: string[] = [];
  if ("enabled" in rec && typeof rec.enabled !== "boolean") {
    errors.push("plan.policy.autonomy.enabled must be a boolean");
  }
  if ("defaultLevel" in rec) {
    const level = rec.defaultLevel;
    if (
      typeof level !== "string" ||
      !AUTONOMY_LEVELS.includes(level as (typeof AUTONOMY_LEVELS)[number])
    ) {
      errors.push(
        `plan.policy.autonomy.defaultLevel must be one of ${JSON.stringify([...AUTONOMY_LEVELS].sort())}; got ${String(level)}`,
      );
    }
  }
  if ("minSampleSize" in rec) {
    const mss = rec.minSampleSize;
    if (typeof mss !== "number" || !Number.isInteger(mss) || mss < 0) {
      errors.push(
        `plan.policy.autonomy.minSampleSize must be a non-negative integer; got ${String(mss)}`,
      );
    }
  }
  for (const key of ["advanceOverrideRateMax", "retreatOverrideRate", "reworkBaseline"] as const) {
    if (key in rec) {
      const rate = rec[key];
      if (!isNumber(rate) || Number(rate) < 0 || Number(rate) > 1) {
        errors.push(
          `plan.policy.autonomy.${key} must be a number between 0.0 and 1.0; got ${String(rate)}`,
        );
      }
    }
  }
  if ("gates" in rec) {
    errors.push(...validateAutonomyGates(rec.gates));
  }
  return errors;
}

function getPolicyBlock(data: Record<string, unknown>): Record<string, unknown> {
  const plan = data.plan;
  if (typeof plan === "object" && plan !== null && !Array.isArray(plan)) {
    const policy = (plan as Record<string, unknown>).policy;
    if (typeof policy === "object" && policy !== null && !Array.isArray(policy)) {
      return policy as Record<string, unknown>;
    }
  }
  return {};
}

/** Resolve plan.policy.autonomy from PROJECT-DEFINITION. */
export function resolveAutonomy(projectRoot: string): AutonomyPolicy {
  const [data, err] = loadProjectDefinition(projectRoot);
  if (data === null) {
    return defaultAutonomyPolicy("default", err);
  }

  const policyBlock = getPolicyBlock(data);
  if (!("autonomy" in policyBlock)) {
    return defaultAutonomyPolicy("default");
  }

  const raw = policyBlock.autonomy;
  const errors = validateAutonomy(raw);
  if (errors.length > 0 || typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return defaultAutonomyPolicy("default-on-error", errors[0] ?? "autonomy must be an object");
  }

  const rec = raw as Record<string, unknown>;
  const gateLevels: Record<string, string> = {};
  const gates = rec.gates;
  if (typeof gates === "object" && gates !== null && !Array.isArray(gates)) {
    for (const [gid, level] of Object.entries(gates as Record<string, unknown>)) {
      if (typeof gid === "string" && typeof level === "string") {
        gateLevels[gid] = level;
      }
    }
  }

  return {
    enabled: typeof rec.enabled === "boolean" ? rec.enabled : true,
    default_level: typeof rec.defaultLevel === "string" ? rec.defaultLevel : DEFAULT_AUTONOMY_LEVEL,
    min_sample_size:
      typeof rec.minSampleSize === "number" && Number.isInteger(rec.minSampleSize)
        ? rec.minSampleSize
        : DEFAULT_AUTONOMY_MIN_SAMPLE_SIZE,
    advance_override_max:
      typeof rec.advanceOverrideRateMax === "number"
        ? rec.advanceOverrideRateMax
        : DEFAULT_AUTONOMY_ADVANCE_OVERRIDE_MAX,
    retreat_override_rate:
      typeof rec.retreatOverrideRate === "number"
        ? rec.retreatOverrideRate
        : DEFAULT_AUTONOMY_RETREAT_OVERRIDE_RATE,
    rework_baseline:
      typeof rec.reworkBaseline === "number"
        ? rec.reworkBaseline
        : DEFAULT_AUTONOMY_REWORK_BASELINE,
    gate_levels: gateLevels,
    source: "typed",
    error: null,
    configured: true,
  };
}

function formatPct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** Recommend an autonomy-level flip from the dial signal (ADVISORY-ONLY). */
export function recommendAutonomyLevel(
  currentLevel: string,
  options: {
    override_rate: number;
    rework_rate: number;
    sample_size: number;
    p0_reversal?: boolean;
    policy?: AutonomyPolicy;
    gate_id?: string | null;
  },
): AutonomyRecommendation {
  const pol = options.policy ?? defaultAutonomyPolicy("default");
  const gateId = options.gate_id ?? null;
  const cur = AUTONOMY_LEVELS.includes(currentLevel as (typeof AUTONOMY_LEVELS)[number])
    ? currentLevel
    : pol.default_level;
  const idx = AUTONOMY_LEVELS.indexOf(cur as (typeof AUTONOMY_LEVELS)[number]);

  const overrideRate = options.override_rate;
  const reworkRate = options.rework_rate;
  const sampleSize = options.sample_size;
  const p0Reversal = options.p0_reversal ?? false;

  if (p0Reversal || overrideRate > pol.retreat_override_rate) {
    const trigger = p0Reversal
      ? "P0 reversal observed"
      : `override rate ${formatPct(overrideRate)} > retreat threshold ${formatPct(pol.retreat_override_rate)}`;
    if (idx === 0) {
      return {
        current_level: cur,
        recommended_level: cur,
        action: AUTONOMY_ACTION_HOLD,
        rationale:
          `hold at ${cur}: ${trigger} but already at the most conservative ` +
          "level (Observe). ADVISORY: a human confirms.",
        gate_id: gateId,
        advisory: true,
      };
    }
    const next = AUTONOMY_LEVELS[idx - 1] ?? cur;
    return {
      current_level: cur,
      recommended_level: next,
      action: AUTONOMY_ACTION_RETREAT,
      rationale:
        `retreat: ${trigger} -- recommend ${next} ` +
        "(restores required human clearances). ADVISORY: a human confirms.",
      gate_id: gateId,
      advisory: true,
    };
  }

  const advanceOk =
    sampleSize >= pol.min_sample_size &&
    overrideRate < pol.advance_override_max &&
    reworkRate <= pol.rework_baseline;

  if (advanceOk) {
    const basis =
      `override ${formatPct(overrideRate)} < ${formatPct(pol.advance_override_max)}, ` +
      `rework ${formatPct(reworkRate)} <= baseline ${formatPct(pol.rework_baseline)}, ` +
      `sample ${sampleSize} >= ${pol.min_sample_size}`;
    if (idx === AUTONOMY_LEVELS.length - 1) {
      return {
        current_level: cur,
        recommended_level: cur,
        action: AUTONOMY_ACTION_HOLD,
        rationale:
          `hold at ${cur}: advance criteria met (${basis}) but already at ` +
          "the most permissive level (Execute).",
        gate_id: gateId,
        advisory: true,
      };
    }
    const next = AUTONOMY_LEVELS[idx + 1] ?? cur;
    return {
      current_level: cur,
      recommended_level: next,
      action: AUTONOMY_ACTION_ADVANCE,
      rationale:
        `advance: ${basis} -- recommend ${next} ` +
        "(would reduce required human clearances). ADVISORY: a human " +
        "confirms; no auto-ratchet.",
      gate_id: gateId,
      advisory: true,
    };
  }

  return {
    current_level: cur,
    recommended_level: cur,
    action: AUTONOMY_ACTION_HOLD,
    rationale:
      `hold at ${cur}: override ${formatPct(overrideRate)}, rework ${formatPct(reworkRate)}, ` +
      `sample ${sampleSize} -- advance criteria not met, no retreat trigger.`,
    gate_id: gateId,
    advisory: true,
  };
}
