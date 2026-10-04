/**
 * Typed plan.policy.specGuard (#1589 Prefer-A Bound).
 *
 * Capacity-shaped advise|enforce drift guard + reserved sqaPass schema.
 * Namespaced under plan["x-directive/policy"] via readPlanPolicy.
 * Framework default stays advise; validate hook stays out of task check in v1.
 */

import { readPlanPolicy } from "./plan-extensions.js";
import { loadProjectDefinition } from "./resolve.js";

/** Canonical dotted path for policy:show / PROJECT-DEFINITION. */
export const FIELD_SPEC_GUARD = "plan.policy.specGuard";

/** CLI alias for `task policy:show --field=specGuard`. */
export const FIELD_SPEC_GUARD_CLI_ALIAS = "specGuard";

/** Namespaced plan-item key for completion impact (#1589 / #1650). */
export const SPEC_IMPACT_KEY = "x-directive/specImpact";

export const SPEC_IMPACT_VALUES = new Set(["none", "delta", "new"] as const);
export type SpecImpactValue = "none" | "delta" | "new";

export const SPEC_GUARD_ENFORCEMENTS = new Set(["advise", "enforce"] as const);
export type SpecGuardEnforcement = "advise" | "enforce";

export const SPEC_GUARD_TRIGGERS = new Set(["scope-complete", "audit", "both"] as const);
export type SpecGuardTrigger = "scope-complete" | "audit" | "both";

export const SQA_SAMPLING = new Set(["shape-changing", "all"] as const);
export type SqaSampling = "shape-changing" | "all";

export const SQA_ON_FAIL = new Set(["escalate", "advise"] as const);
export type SqaOnFail = "escalate" | "advise";

/** First-ship default: enabled advise (Bound closed decision). */
export const DEFAULT_SPEC_GUARD_ENABLED = true;
export const DEFAULT_DRIFT_ENFORCEMENT: SpecGuardEnforcement = "advise";
export const DEFAULT_DRIFT_TRIGGER: SpecGuardTrigger = "both";
export const DEFAULT_SQA_ENFORCEMENT: SpecGuardEnforcement = "advise";
export const DEFAULT_SQA_SAMPLING: SqaSampling = "shape-changing";
export const DEFAULT_SQA_ON_FAIL: SqaOnFail = "escalate";

export interface SpecGuardDriftGuard {
  readonly enforcement: SpecGuardEnforcement;
  readonly trigger: SpecGuardTrigger;
}

/**
 * Reserved SQA black-box pass schema (#1589 C3).
 * Engine is a documented no-op in v1; escalate may reuse pending-human-decisions later.
 */
export interface SpecGuardSqaPass {
  readonly enforcement: SpecGuardEnforcement;
  readonly sampling: SqaSampling;
  readonly onFail: SqaOnFail;
}

export interface SpecGuardConfig {
  readonly enabled: boolean;
  readonly driftGuard: SpecGuardDriftGuard;
  readonly sqaPass: SpecGuardSqaPass;
}

export type SpecGuardSource = "typed" | "default" | "default-on-error";

export interface SpecGuardResolved extends SpecGuardConfig {
  readonly source: SpecGuardSource;
  readonly error: string | null;
  /** Explicit unknown/unhardened baseline when no specification artifact exists. */
  readonly baselineStatus: "unknown" | "unhardened" | "present";
}

function defaultConfig(): SpecGuardConfig {
  return {
    enabled: DEFAULT_SPEC_GUARD_ENABLED,
    driftGuard: {
      enforcement: DEFAULT_DRIFT_ENFORCEMENT,
      trigger: DEFAULT_DRIFT_TRIGGER,
    },
    sqaPass: {
      enforcement: DEFAULT_SQA_ENFORCEMENT,
      sampling: DEFAULT_SQA_SAMPLING,
      onFail: DEFAULT_SQA_ON_FAIL,
    },
  };
}

function defaultResolved(
  source: SpecGuardSource,
  error: string | null = null,
  baselineStatus: SpecGuardResolved["baselineStatus"] = "unknown",
): SpecGuardResolved {
  return {
    ...defaultConfig(),
    source,
    error,
    baselineStatus,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate a `plan.policy.specGuard` payload (including reserved sqaPass). */
export function validateSpecGuard(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    return [`${FIELD_SPEC_GUARD} must be an object; got ${typeof value}`];
  }
  const errors: string[] = [];
  if ("enabled" in value && typeof value.enabled !== "boolean") {
    errors.push(`${FIELD_SPEC_GUARD}.enabled must be a boolean`);
  }
  if ("driftGuard" in value) {
    if (!isRecord(value.driftGuard)) {
      errors.push(`${FIELD_SPEC_GUARD}.driftGuard must be an object`);
    } else {
      const dg = value.driftGuard;
      if (
        "enforcement" in dg &&
        (typeof dg.enforcement !== "string" ||
          !SPEC_GUARD_ENFORCEMENTS.has(dg.enforcement as SpecGuardEnforcement))
      ) {
        errors.push(
          `${FIELD_SPEC_GUARD}.driftGuard.enforcement must be one of advise|enforce; got ${String(dg.enforcement)}`,
        );
      }
      if (
        "trigger" in dg &&
        (typeof dg.trigger !== "string" || !SPEC_GUARD_TRIGGERS.has(dg.trigger as SpecGuardTrigger))
      ) {
        errors.push(
          `${FIELD_SPEC_GUARD}.driftGuard.trigger must be one of scope-complete|audit|both; got ${String(dg.trigger)}`,
        );
      }
    }
  }
  if ("sqaPass" in value) {
    if (!isRecord(value.sqaPass)) {
      errors.push(`${FIELD_SPEC_GUARD}.sqaPass must be an object`);
    } else {
      const sqa = value.sqaPass;
      if (
        "enforcement" in sqa &&
        (typeof sqa.enforcement !== "string" ||
          !SPEC_GUARD_ENFORCEMENTS.has(sqa.enforcement as SpecGuardEnforcement))
      ) {
        errors.push(
          `${FIELD_SPEC_GUARD}.sqaPass.enforcement must be one of advise|enforce; got ${String(sqa.enforcement)}`,
        );
      }
      if (
        "sampling" in sqa &&
        (typeof sqa.sampling !== "string" || !SQA_SAMPLING.has(sqa.sampling as SqaSampling))
      ) {
        errors.push(
          `${FIELD_SPEC_GUARD}.sqaPass.sampling must be one of shape-changing|all; got ${String(sqa.sampling)}`,
        );
      }
      if (
        "onFail" in sqa &&
        (typeof sqa.onFail !== "string" || !SQA_ON_FAIL.has(sqa.onFail as SqaOnFail))
      ) {
        errors.push(
          `${FIELD_SPEC_GUARD}.sqaPass.onFail must be one of escalate|advise; got ${String(sqa.onFail)}`,
        );
      }
    }
  }
  return errors;
}

function parseDriftGuard(raw: unknown): SpecGuardDriftGuard {
  if (!isRecord(raw)) {
    return { enforcement: DEFAULT_DRIFT_ENFORCEMENT, trigger: DEFAULT_DRIFT_TRIGGER };
  }
  const enforcement =
    typeof raw.enforcement === "string" &&
    SPEC_GUARD_ENFORCEMENTS.has(raw.enforcement as SpecGuardEnforcement)
      ? (raw.enforcement as SpecGuardEnforcement)
      : DEFAULT_DRIFT_ENFORCEMENT;
  const trigger =
    typeof raw.trigger === "string" && SPEC_GUARD_TRIGGERS.has(raw.trigger as SpecGuardTrigger)
      ? (raw.trigger as SpecGuardTrigger)
      : DEFAULT_DRIFT_TRIGGER;
  return { enforcement, trigger };
}

function parseSqaPass(raw: unknown): SpecGuardSqaPass {
  if (!isRecord(raw)) {
    return {
      enforcement: DEFAULT_SQA_ENFORCEMENT,
      sampling: DEFAULT_SQA_SAMPLING,
      onFail: DEFAULT_SQA_ON_FAIL,
    };
  }
  const enforcement =
    typeof raw.enforcement === "string" &&
    SPEC_GUARD_ENFORCEMENTS.has(raw.enforcement as SpecGuardEnforcement)
      ? (raw.enforcement as SpecGuardEnforcement)
      : DEFAULT_SQA_ENFORCEMENT;
  const sampling =
    typeof raw.sampling === "string" && SQA_SAMPLING.has(raw.sampling as SqaSampling)
      ? (raw.sampling as SqaSampling)
      : DEFAULT_SQA_SAMPLING;
  const onFail =
    typeof raw.onFail === "string" && SQA_ON_FAIL.has(raw.onFail as SqaOnFail)
      ? (raw.onFail as SqaOnFail)
      : DEFAULT_SQA_ON_FAIL;
  return { enforcement, sampling, onFail };
}

/** Resolve typed block without project I/O (unit-test seam). */
export function resolveSpecGuardFromTypedBlock(
  raw: unknown,
  baselineStatus: SpecGuardResolved["baselineStatus"] = "unknown",
): SpecGuardResolved {
  const errors = validateSpecGuard(raw);
  if (errors.length > 0) {
    return defaultResolved(
      "default-on-error",
      errors[0] ?? "invalid specGuard block",
      baselineStatus,
    );
  }
  if (!isRecord(raw)) {
    return defaultResolved("default", null, baselineStatus);
  }
  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_SPEC_GUARD_ENABLED;
  return {
    enabled,
    driftGuard: parseDriftGuard(raw.driftGuard),
    sqaPass: parseSqaPass(raw.sqaPass),
    source: "typed",
    error: null,
    baselineStatus,
  };
}

export interface ResolveSpecGuardOptions {
  /** When true, baselineStatus becomes present if a specification artifact exists. */
  readonly hasSpecification?: boolean;
}

/**
 * Resolve plan.policy.specGuard from PROJECT-DEFINITION (#1589).
 * Malformed typed blocks self-heal to defaults (default-on-error).
 */
export function resolveSpecGuard(
  projectRoot: string,
  options: ResolveSpecGuardOptions = {},
): SpecGuardResolved {
  const baselineStatus: SpecGuardResolved["baselineStatus"] =
    options.hasSpecification === true ? "present" : "unknown";
  const [data, err] = loadProjectDefinition(projectRoot);
  if (data === null) {
    return defaultResolved("default-on-error", err, baselineStatus);
  }
  const policyBlock = readPlanPolicy(data.plan);
  if (!isRecord(policyBlock) || !("specGuard" in policyBlock)) {
    return defaultResolved("default", null, baselineStatus);
  }
  return resolveSpecGuardFromTypedBlock(policyBlock.specGuard, baselineStatus);
}

/** C3 reserved: sqaPass engine is a documented no-op in v1. */
export function runSqaPassNoop(_projectRoot: string): {
  readonly status: "noop";
  readonly message: string;
} {
  return {
    status: "noop",
    message:
      "specGuard.sqaPass engine is reserved (schema only) in v1; no SQA judgment runs (#1589 C3)",
  };
}

export function readSpecImpact(item: Record<string, unknown>): SpecImpactValue | null {
  const raw = item[SPEC_IMPACT_KEY];
  if (typeof raw !== "string") return null;
  return SPEC_IMPACT_VALUES.has(raw as SpecImpactValue) ? (raw as SpecImpactValue) : null;
}

export interface SpecGuardPolicyField {
  readonly name: typeof FIELD_SPEC_GUARD;
  readonly current: SpecGuardConfig;
  readonly default: SpecGuardConfig;
  readonly source: string;
}

/** Inspector row for `task policy:show --field=specGuard`. */
export function inspectSpecGuard(
  _data: Record<string, unknown> | null,
  projectRoot?: string,
): SpecGuardPolicyField {
  const resolved =
    projectRoot !== undefined && projectRoot.length > 0
      ? resolveSpecGuard(projectRoot)
      : defaultResolved("default");
  return {
    name: FIELD_SPEC_GUARD,
    current: {
      enabled: resolved.enabled,
      driftGuard: resolved.driftGuard,
      sqaPass: resolved.sqaPass,
    },
    default: defaultConfig(),
    source: resolved.source,
  };
}
