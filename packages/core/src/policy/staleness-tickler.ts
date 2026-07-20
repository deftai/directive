import type {
  StalenessTicklerPolicy,
  StalenessTicklerSnoozePolicy,
  StalenessTicklerTierThresholds,
  StalenessTicklerWeights,
} from "../staleness-tickler/types.js";
import { readPlanPolicy } from "./plan-extensions.js";

export const FIELD_STALENESS_TICKLER = "plan.policy.stalenessTickler";
export const FIELD_STALENESS_TICKLER_CLI_ALIAS = "stalenessTickler";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const DEFAULT_STALENESS_TICKLER_WEIGHTS: StalenessTicklerWeights = {
  directiveMajor: 10,
  directiveMinor: 3,
  directivePatch: 1,
  schemaMajor: 15,
  schemaMinor: 5,
  agePerDay: 0.1,
  deferral: 2,
};

export const DEFAULT_STALENESS_TICKLER_TIERS: StalenessTicklerTierThresholds = {
  noticeMinorThreshold: 2,
  strongAgeMs: 30 * MS_PER_DAY,
  assertDeferralCap: 5,
};

export const DEFAULT_STALENESS_TICKLER_SNOOZE: StalenessTicklerSnoozePolicy = {
  quietMs: 7 * MS_PER_DAY,
  noticeMs: MS_PER_DAY,
  strongMs: 4 * 60 * 60 * 1000,
  maxWidenMultiplier: 4,
};

export const DEFAULT_STALENESS_TICKLER_POLICY: StalenessTicklerPolicy = {
  enabled: true,
  optOut: false,
  weights: DEFAULT_STALENESS_TICKLER_WEIGHTS,
  tiers: DEFAULT_STALENESS_TICKLER_TIERS,
  snooze: DEFAULT_STALENESS_TICKLER_SNOOZE,
};

export interface StalenessTicklerPolicyField {
  readonly name: string;
  readonly current: StalenessTicklerPolicy;
  readonly default: StalenessTicklerPolicy;
  readonly source: string;
}

function readBoolean(rec: Record<string, unknown>, key: string, fallback: boolean): boolean {
  if (key in rec && typeof rec[key] === "boolean") {
    return rec[key] as boolean;
  }
  return fallback;
}

function readNumber(rec: Record<string, unknown>, key: string, fallback: number): number {
  if (key in rec && typeof rec[key] === "number" && Number.isFinite(rec[key] as number)) {
    return rec[key] as number;
  }
  return fallback;
}

function readWeights(raw: unknown): StalenessTicklerWeights {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return DEFAULT_STALENESS_TICKLER_WEIGHTS;
  }
  const rec = raw as Record<string, unknown>;
  return {
    directiveMajor: readNumber(
      rec,
      "directiveMajor",
      DEFAULT_STALENESS_TICKLER_WEIGHTS.directiveMajor,
    ),
    directiveMinor: readNumber(
      rec,
      "directiveMinor",
      DEFAULT_STALENESS_TICKLER_WEIGHTS.directiveMinor,
    ),
    directivePatch: readNumber(
      rec,
      "directivePatch",
      DEFAULT_STALENESS_TICKLER_WEIGHTS.directivePatch,
    ),
    schemaMajor: readNumber(rec, "schemaMajor", DEFAULT_STALENESS_TICKLER_WEIGHTS.schemaMajor),
    schemaMinor: readNumber(rec, "schemaMinor", DEFAULT_STALENESS_TICKLER_WEIGHTS.schemaMinor),
    agePerDay: readNumber(rec, "agePerDay", DEFAULT_STALENESS_TICKLER_WEIGHTS.agePerDay),
    deferral: readNumber(rec, "deferral", DEFAULT_STALENESS_TICKLER_WEIGHTS.deferral),
  };
}

function readTierThresholds(raw: unknown): StalenessTicklerTierThresholds {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return DEFAULT_STALENESS_TICKLER_TIERS;
  }
  const rec = raw as Record<string, unknown>;
  return {
    noticeMinorThreshold: readNumber(
      rec,
      "noticeMinorThreshold",
      DEFAULT_STALENESS_TICKLER_TIERS.noticeMinorThreshold,
    ),
    strongAgeMs: readNumber(rec, "strongAgeMs", DEFAULT_STALENESS_TICKLER_TIERS.strongAgeMs),
    assertDeferralCap: readNumber(
      rec,
      "assertDeferralCap",
      DEFAULT_STALENESS_TICKLER_TIERS.assertDeferralCap,
    ),
  };
}

function readSnooze(raw: unknown): StalenessTicklerSnoozePolicy {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return DEFAULT_STALENESS_TICKLER_SNOOZE;
  }
  const rec = raw as Record<string, unknown>;
  return {
    quietMs: readNumber(rec, "quietMs", DEFAULT_STALENESS_TICKLER_SNOOZE.quietMs),
    noticeMs: readNumber(rec, "noticeMs", DEFAULT_STALENESS_TICKLER_SNOOZE.noticeMs),
    strongMs: readNumber(rec, "strongMs", DEFAULT_STALENESS_TICKLER_SNOOZE.strongMs),
    maxWidenMultiplier: readNumber(
      rec,
      "maxWidenMultiplier",
      DEFAULT_STALENESS_TICKLER_SNOOZE.maxWidenMultiplier,
    ),
  };
}

export function resolveStalenessTicklerPolicy(raw: unknown): StalenessTicklerPolicy {
  if (raw === null || raw === undefined) {
    return DEFAULT_STALENESS_TICKLER_POLICY;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return DEFAULT_STALENESS_TICKLER_POLICY;
  }
  const rec = raw as Record<string, unknown>;
  return {
    enabled: readBoolean(rec, "enabled", DEFAULT_STALENESS_TICKLER_POLICY.enabled),
    optOut: readBoolean(rec, "optOut", DEFAULT_STALENESS_TICKLER_POLICY.optOut),
    weights: readWeights(rec.weights),
    tiers: readTierThresholds(rec.tiers),
    snooze: readSnooze(rec.snooze),
  };
}

export function validateStalenessTickler(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return [`${FIELD_STALENESS_TICKLER} must be an object; got ${typeof value}`];
  }
  const rec = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of ["enabled", "optOut"] as const) {
    if (key in rec && typeof rec[key] !== "boolean") {
      errors.push(`${FIELD_STALENESS_TICKLER}.${key} must be a boolean`);
    }
  }
  return errors;
}

function fieldFromResolved(
  resolved: StalenessTicklerPolicy,
  source: string,
): StalenessTicklerPolicyField {
  return {
    name: FIELD_STALENESS_TICKLER,
    current: resolved,
    default: DEFAULT_STALENESS_TICKLER_POLICY,
    source,
  };
}

/** Inspector row for `policy:show --field=stalenessTickler`. */
export function inspectStalenessTickler(
  data: Record<string, unknown> | null,
): StalenessTicklerPolicyField {
  if (data === null) {
    return fieldFromResolved(DEFAULT_STALENESS_TICKLER_POLICY, "default");
  }
  const policyBlock = readPlanPolicy(data.plan);
  if (
    typeof policyBlock !== "object" ||
    policyBlock === null ||
    Array.isArray(policyBlock) ||
    !("stalenessTickler" in (policyBlock as Record<string, unknown>))
  ) {
    return fieldFromResolved(DEFAULT_STALENESS_TICKLER_POLICY, "default");
  }
  const resolved = resolveStalenessTicklerPolicy(
    (policyBlock as Record<string, unknown>).stalenessTickler,
  );
  return fieldFromResolved(resolved, "typed");
}

/** Resolve typed staleness tickler policy from PROJECT-DEFINITION. */
export function loadStalenessTicklerPolicy(
  data: Record<string, unknown> | null,
): StalenessTicklerPolicy {
  if (data === null) {
    return DEFAULT_STALENESS_TICKLER_POLICY;
  }
  const policyBlock = readPlanPolicy(data.plan);
  if (
    typeof policyBlock !== "object" ||
    policyBlock === null ||
    Array.isArray(policyBlock) ||
    !("stalenessTickler" in (policyBlock as Record<string, unknown>))
  ) {
    return DEFAULT_STALENESS_TICKLER_POLICY;
  }
  return resolveStalenessTicklerPolicy((policyBlock as Record<string, unknown>).stalenessTickler);
}
