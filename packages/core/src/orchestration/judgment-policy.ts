/**
 * Judgment-gate policy resolution (#1419). Port of scripts/policy.py judgment-gate section.
 */
import { loadProjectDefinition } from "../policy/resolve.js";

export const GATE_CLASSES = new Set(["mechanical", "declared"]);
export const GATE_TIERS = new Set(["auto", "review", "block"]);
export const GATE_MATCH_PREDICATES = new Set(["labels", "body-text", "paths", "state", "age-days"]);
export const GATE_MATCH_STATES = new Set(["open", "closed"]);

export interface JudgmentGate {
  readonly gate_id: string;
  readonly gate_class: string;
  readonly match: Record<string, unknown>;
  readonly tier: string;
  readonly reason: string;
  readonly required_human_reviewers: number;
}

export interface JudgmentGatesPolicy {
  readonly gates: readonly JudgmentGate[];
  readonly disabled: readonly string[];
  readonly source: string;
  readonly error: string | null;
}

function validateStrList(value: unknown, prefix: string, key: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [`${prefix}.${key} must be a non-empty list of strings`];
  }
  const errors: string[] = [];
  for (let j = 0; j < value.length; j += 1) {
    const item = value[j];
    if (typeof item !== "string" || item.length === 0) {
      errors.push(`${prefix}.${key}[${j}] must be a non-empty string`);
    }
  }
  return errors;
}

function validateGlobPredicate(value: unknown, prefix: string): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [`${prefix} must be an object with an 'any-of' glob list`];
  }
  const obj = value as Record<string, unknown>;
  if (!("any-of" in obj)) {
    return [`${prefix} requires 'any-of'`];
  }
  return validateStrList(obj["any-of"], prefix, "any-of");
}

function validateGateLabels(value: unknown, prefix: string): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [`${prefix} must be an object`];
  }
  const obj = value as Record<string, unknown>;
  const anyOf = obj["any-of"];
  const allOf = obj["all-of"];
  if (anyOf === undefined && allOf === undefined) {
    return [`${prefix} requires 'any-of' or 'all-of'`];
  }
  if (anyOf !== undefined && allOf !== undefined) {
    return [`${prefix}: 'any-of' and 'all-of' are mutually exclusive`];
  }
  const key = anyOf !== undefined ? "any-of" : "all-of";
  return validateStrList(anyOf ?? allOf, prefix, key);
}

function validateGateAnyOf(value: unknown, prefix: string): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [`${prefix} must be an object`];
  }
  const obj = value as Record<string, unknown>;
  if (!("any-of" in obj)) {
    return [`${prefix} requires 'any-of'`];
  }
  return validateStrList(obj["any-of"], prefix, "any-of");
}

function validateGateAgeDays(value: unknown, prefix: string): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [`${prefix} must be an object`];
  }
  const gt = (value as Record<string, unknown>).gt;
  if (typeof gt !== "number" || !Number.isInteger(gt) || gt < 0) {
    return [`${prefix}.gt must be a non-negative integer; got ${JSON.stringify(gt)}`];
  }
  return [];
}

function validateGateMatch(match: unknown, prefix: string): string[] {
  if (typeof match !== "object" || match === null || Array.isArray(match)) {
    return [`${prefix} must be an object`];
  }
  const mobj = match as Record<string, unknown>;
  const used = Object.keys(mobj)
    .filter((k) => GATE_MATCH_PREDICATES.has(k))
    .sort();
  if (used.length === 0) {
    return [`${prefix} requires at least one of ${[...GATE_MATCH_PREDICATES].sort().join(", ")}`];
  }
  const errors: string[] = [];
  const extra = Object.keys(mobj)
    .filter((k) => !GATE_MATCH_PREDICATES.has(k))
    .sort();
  if (extra.length > 0) {
    errors.push(
      `${prefix} has unrecognised predicate(s) ${JSON.stringify(extra)}; expected only ${[...GATE_MATCH_PREDICATES].sort().join(", ")}`,
    );
  }
  if ("paths" in mobj) {
    errors.push(...validateGlobPredicate(mobj.paths, `${prefix}.paths`));
  }
  if ("labels" in mobj) {
    errors.push(...validateGateLabels(mobj.labels, `${prefix}.labels`));
  }
  if ("body-text" in mobj) {
    errors.push(...validateGateAnyOf(mobj["body-text"], `${prefix}.body-text`));
  }
  if ("state" in mobj && !GATE_MATCH_STATES.has(String(mobj.state))) {
    errors.push(
      `${prefix}.state must be one of ${[...GATE_MATCH_STATES].sort().join(", ")}; got ${JSON.stringify(mobj.state)}`,
    );
  }
  if ("age-days" in mobj) {
    errors.push(...validateGateAgeDays(mobj["age-days"], `${prefix}.age-days`));
  }
  return errors;
}

function validateSingleGate(gate: unknown, prefix: string): [string[], string | null] {
  if (typeof gate !== "object" || gate === null || Array.isArray(gate)) {
    return [[`${prefix} must be an object; got ${typeof gate}`], null];
  }
  const g = gate as Record<string, unknown>;
  const errors: string[] = [];
  const gid = g.id;
  let resolvedId: string | null = null;
  if (typeof gid !== "string" || !gid.trim()) {
    errors.push(`${prefix}.id must be a non-empty string`);
  } else {
    resolvedId = gid;
  }
  if (!GATE_CLASSES.has(String(g.class))) {
    errors.push(
      `${prefix}.class must be one of ${[...GATE_CLASSES].sort().join(", ")}; got ${JSON.stringify(g.class)}`,
    );
  }
  if (!GATE_TIERS.has(String(g.tier))) {
    errors.push(
      `${prefix}.tier must be one of ${[...GATE_TIERS].sort().join(", ")}; got ${JSON.stringify(g.tier)}`,
    );
  }
  const reason = g.reason;
  if (typeof reason !== "string" || !reason.trim()) {
    errors.push(`${prefix}.reason must be a non-empty string`);
  }
  if ("requiredHumanReviewers" in g) {
    const rhr = g.requiredHumanReviewers;
    if (typeof rhr !== "number" || !Number.isInteger(rhr) || rhr < 0) {
      errors.push(
        `${prefix}.requiredHumanReviewers must be a non-negative integer; got ${JSON.stringify(rhr)}`,
      );
    }
  }
  errors.push(...validateGateMatch(g.match, `${prefix}.match`));
  return [errors, resolvedId];
}

export function validateJudgmentGates(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return [`plan.policy.judgmentGates must be a list of gate objects; got ${typeof value}`];
  }
  const errors: string[] = [];
  const ids: string[] = [];
  for (let idx = 0; idx < value.length; idx += 1) {
    const [gateErrors, gateId] = validateSingleGate(
      value[idx],
      `plan.policy.judgmentGates[${idx}]`,
    );
    errors.push(...gateErrors);
    if (gateId !== null) {
      ids.push(gateId);
    }
  }
  const duplicates = [...new Set(ids.filter((g, i) => ids.indexOf(g) !== i))].sort();
  if (duplicates.length > 0) {
    errors.push(
      `plan.policy.judgmentGates ids must be unique; duplicates: ${duplicates.join(", ")}`,
    );
  }
  return errors;
}

export function validateJudgmentGatesDisabled(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return [`plan.policy.judgmentGatesDisabled must be a list of gate ids; got ${typeof value}`];
  }
  const errors: string[] = [];
  for (let j = 0; j < value.length; j += 1) {
    const item = value[j];
    if (typeof item !== "string" || !item.trim()) {
      errors.push(`plan.policy.judgmentGatesDisabled[${j}] must be a non-empty string`);
    }
  }
  return errors;
}

function defaultPolicy(source: string, error: string | null = null): JudgmentGatesPolicy {
  return { gates: [], disabled: [], source, error };
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

/** Resolve judgmentGates + judgmentGatesDisabled from PROJECT-DEFINITION. */
export function resolveJudgmentGates(projectRoot: string): JudgmentGatesPolicy {
  const [data, err] = loadProjectDefinition(projectRoot);
  if (data === null) {
    return defaultPolicy("default", err);
  }
  const policyBlock = getPolicyBlock(data);
  const rawGates = policyBlock.judgmentGates;
  const rawDisabled = policyBlock.judgmentGatesDisabled;
  if (rawGates === undefined && rawDisabled === undefined) {
    return defaultPolicy("default");
  }
  const errors = [
    ...validateJudgmentGates(rawGates),
    ...validateJudgmentGatesDisabled(rawDisabled),
  ];
  if (errors.length > 0) {
    return defaultPolicy("default-on-error", errors[0] ?? null);
  }
  const gates: JudgmentGate[] = [];
  if (Array.isArray(rawGates)) {
    for (const gate of rawGates) {
      if (typeof gate !== "object" || gate === null || Array.isArray(gate)) {
        continue;
      }
      const g = gate as Record<string, unknown>;
      gates.push({
        gate_id: String(g.id),
        gate_class: String(g.class),
        match: { ...(g.match as Record<string, unknown>) },
        tier: String(g.tier),
        reason: String(g.reason),
        required_human_reviewers: Number(g.requiredHumanReviewers ?? 0),
      });
    }
  }
  const disabled = Array.isArray(rawDisabled)
    ? rawDisabled.filter((d): d is string => typeof d === "string")
    : [];
  return { gates, disabled, source: "typed", error: null };
}
