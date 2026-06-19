import {
  validateTriageAutoClassifyOnPlan,
  validateTriageHoldMarkersOnPlan,
} from "../triage/classify/index.js";
import { validateRankingLabels } from "../triage/queue/ranking-labels.js";
import { pyStrRepr, pythonTypeName } from "../triage/scope/python-repr.js";
import {
  validateTriageScopeIgnoresOnPlan,
  validateTriageScopeOnPlan,
} from "../triage/scope/validate.js";
import type { JsonObject } from "./schema.js";

function validateWipCap(value: unknown): string[] {
  const errors: string[] = [];
  if (value === null || value === undefined) {
    return errors;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    const repr =
      typeof value === "string"
        ? pyStrRepr(value)
        : value === null
          ? "None"
          : typeof value === "boolean"
            ? value
              ? "True"
              : "False"
            : String(value);
    errors.push(`plan.policy.wipCap must be an integer; got ${pythonTypeName(value)} (${repr})`);
    return errors;
  }
  if (value < 0) {
    errors.push(`plan.policy.wipCap must be >= 0; got ${value}`);
  }
  return errors;
}

/** vbrief_validate hook: validate ``plan.policy.wipCap`` (#1124). */
export function validateWipCapOnPlan(plan: unknown, filepath: string): string[] {
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return [];
  }
  const policy = (plan as JsonObject).policy;
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    return [];
  }
  if (!("wipCap" in (policy as JsonObject))) {
    return [];
  }
  const out: string[] = [];
  for (const err of validateWipCap((policy as JsonObject).wipCap)) {
    out.push(`${filepath}: ${err} (#1124)`);
  }
  return out;
}

function validateSessionRitualStalenessHours(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    const repr =
      typeof value === "string"
        ? pyStrRepr(value)
        : value === null
          ? "None"
          : typeof value === "boolean"
            ? value
              ? "True"
              : "False"
            : String(value);
    return [
      "plan.policy.sessionRitualStalenessHours must be an integer; got " +
        `${pythonTypeName(value)} (${repr})`,
    ];
  }
  if (value <= 0) {
    return [`plan.policy.sessionRitualStalenessHours must be > 0; got ${value}`];
  }
  return [];
}

/** vbrief_validate hook for ``sessionRitualStalenessHours`` (#1348). */
export function validateSessionRitualStalenessHoursOnPlan(
  plan: unknown,
  filepath: string,
): string[] {
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return [];
  }
  const policy = (plan as JsonObject).policy;
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    return [];
  }
  if (!("sessionRitualStalenessHours" in (policy as JsonObject))) {
    return [];
  }
  const out: string[] = [];
  for (const err of validateSessionRitualStalenessHours(
    (policy as JsonObject).sessionRitualStalenessHours,
  )) {
    out.push(`${filepath}: ${err} (#1348)`);
  }
  return out;
}

/** vbrief_validate hook: validate ``plan.policy.triageRankingLabels`` (#1128). */
export function validateTriageRankingLabelsOnPlan(plan: unknown, filepath: string): string[] {
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return [];
  }
  const policy = (plan as JsonObject).policy;
  const raw =
    typeof policy === "object" && policy !== null && !Array.isArray(policy)
      ? (policy as JsonObject).triageRankingLabels
      : undefined;
  if (raw === undefined || raw === null) {
    return [];
  }
  const { errors } = validateRankingLabels(raw);
  return errors.map((err) => `${filepath}: ${err} (#1128)`);
}

/** Run all PROJECT-DEFINITION policy hooks (mirrors lazy-import block in Python). */
export function runProjectDefinitionHooks(plan: unknown, filepath: string): string[] {
  const errors: string[] = [];
  try {
    errors.push(...validateTriageScopeOnPlan(plan, filepath));
  } catch {
    /* hook must not break validation */
  }
  try {
    errors.push(...validateTriageScopeIgnoresOnPlan(plan, filepath));
  } catch {
    /* hook must not break validation */
  }
  try {
    errors.push(...validateTriageAutoClassifyOnPlan(plan, filepath));
    errors.push(...validateTriageHoldMarkersOnPlan(plan, filepath));
  } catch {
    /* hook must not break validation */
  }
  try {
    errors.push(...validateTriageRankingLabelsOnPlan(plan, filepath));
  } catch {
    /* hook must not break validation */
  }
  try {
    errors.push(...validateWipCapOnPlan(plan, filepath));
  } catch {
    /* hook must not break validation */
  }
  try {
    errors.push(...validateSessionRitualStalenessHoursOnPlan(plan, filepath));
  } catch {
    /* hook must not break validation */
  }
  return errors;
}
