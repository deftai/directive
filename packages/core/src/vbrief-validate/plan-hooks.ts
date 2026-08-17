import { validateCheckResume } from "../policy/check-resume.js";
import { validateCoverageDebt } from "../policy/coverage-debt.js";
import { validateHostHooks } from "../policy/host-hooks.js";
import { validateHostSlashCommands } from "../policy/host-slash-commands.js";
import { readPlanPolicy } from "../policy/plan-extensions.js";
import { parseProjectInvariants } from "../policy/project-invariants.js";
import { validateRuntimeAuthority } from "../policy/runtime-authority.js";
import { validateStalenessTickler } from "../policy/staleness-tickler.js";
import { validateOpenClawProductCommands } from "../slash/openclaw-deposit.js";
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
  const policy = readPlanPolicy(plan);
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
  const policy = readPlanPolicy(plan);
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

function validateForgeOutageRetryMinutes(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    const repr =
      typeof value === "string"
        ? pyStrRepr(value)
        : typeof value === "boolean"
          ? value
            ? "True"
            : "False"
          : String(value);
    return [
      "plan.policy.forgeOutageRetryMinutes must be an integer; got " +
        `${pythonTypeName(value)} (${repr})`,
    ];
  }
  if (value < 5) {
    return [`plan.policy.forgeOutageRetryMinutes must be >= 5; got ${value}`];
  }
  return [];
}

/** vbrief_validate hook for ``projectInvariants`` (#3425). */
export function validateProjectInvariantsOnPlan(plan: unknown, filepath: string): string[] {
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return [];
  }
  const policy = readPlanPolicy(plan);
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    return [];
  }
  if (!("projectInvariants" in (policy as JsonObject))) {
    return [];
  }
  const { errors } = parseProjectInvariants((policy as JsonObject).projectInvariants);
  return errors.map((err) => `${filepath}: ${err} (#3425)`);
}

/** vbrief_validate hook for ``forgeOutageRetryMinutes`` (#3422). */
export function validateForgeOutageRetryMinutesOnPlan(plan: unknown, filepath: string): string[] {
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return [];
  }
  const policy = readPlanPolicy(plan);
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    return [];
  }
  if (!("forgeOutageRetryMinutes" in (policy as JsonObject))) {
    return [];
  }
  const out: string[] = [];
  for (const err of validateForgeOutageRetryMinutes(
    (policy as JsonObject).forgeOutageRetryMinutes,
  )) {
    out.push(`${filepath}: ${err} (#3422)`);
  }
  return out;
}

/** vbrief_validate hook: validate ``plan.policy.triageRankingLabels`` (#1128). */
export function validateTriageRankingLabelsOnPlan(plan: unknown, filepath: string): string[] {
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return [];
  }
  const policy = readPlanPolicy(plan);
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

/** vbrief_validate hook: validate ``plan.policy.runtimeAuthority`` (#1394). */
export function validateRuntimeAuthorityOnPlan(plan: unknown, filepath: string): string[] {
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return [];
  }
  const policy = readPlanPolicy(plan);
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    return [];
  }
  if (!("runtimeAuthority" in (policy as JsonObject))) {
    return [];
  }
  const out: string[] = [];
  for (const err of validateRuntimeAuthority((policy as JsonObject).runtimeAuthority)) {
    out.push(`${filepath}: ${err} (#1394)`);
  }
  return out;
}

/** vbrief_validate hook: validate ``plan.policy.hostHooks`` (#2752). */
export function validateHostHooksOnPlan(plan: unknown, filepath: string): string[] {
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return [];
  }
  const policy = readPlanPolicy(plan);
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    return [];
  }
  if (!("hostHooks" in (policy as JsonObject))) {
    return [];
  }
  const out: string[] = [];
  for (const err of validateHostHooks((policy as JsonObject).hostHooks)) {
    out.push(`${filepath}: ${err} (#2752)`);
  }
  return out;
}

/** vbrief_validate hook: validate ``plan.policy.hostSlashCommands`` (#3054). */
export function validateHostSlashCommandsOnPlan(plan: unknown, filepath: string): string[] {
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return [];
  }
  const policy = readPlanPolicy(plan);
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    return [];
  }
  if (!("hostSlashCommands" in (policy as JsonObject))) {
    return [];
  }
  const out: string[] = [];
  for (const err of validateHostSlashCommands((policy as JsonObject).hostSlashCommands)) {
    out.push(`${filepath}: ${err} (#3054)`);
  }
  return out;
}

/** vbrief_validate hook: validate ``plan.policy.openClawProductCommands`` (#3064). */
export function validateOpenClawProductCommandsOnPlan(plan: unknown, filepath: string): string[] {
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return [];
  }
  const policy = readPlanPolicy(plan);
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    return [];
  }
  if (!("openClawProductCommands" in (policy as JsonObject))) {
    return [];
  }
  const out: string[] = [];
  for (const err of validateOpenClawProductCommands(
    (policy as JsonObject).openClawProductCommands,
  )) {
    out.push(`${filepath}: ${err} (#3064)`);
  }
  return out;
}

/** vbrief_validate hook: validate ``plan.policy.stalenessTickler`` (#2489). */
export function validateStalenessTicklerOnPlan(plan: unknown, filepath: string): string[] {
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return [];
  }
  const policy = readPlanPolicy(plan);
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    return [];
  }
  if (!("stalenessTickler" in (policy as JsonObject))) {
    return [];
  }
  const out: string[] = [];
  for (const err of validateStalenessTickler((policy as JsonObject).stalenessTickler)) {
    out.push(`${filepath}: ${err} (#2489)`);
  }
  return out;
}

/** vbrief_validate hook: validate ``plan.policy.coverageDebt`` (#3189). */
export function validateCoverageDebtOnPlan(plan: unknown, filepath: string): string[] {
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return [];
  }
  const policy = readPlanPolicy(plan);
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    return [];
  }
  if (!("coverageDebt" in (policy as JsonObject))) {
    return [];
  }
  const raw = (policy as JsonObject).coverageDebt;
  // Explicit null is a typed key with invalid value — fail closed at validation time.
  if (raw === null) {
    return [`${filepath}: plan.policy.coverageDebt must be an object; got null (#3189)`];
  }
  const out: string[] = [];
  for (const err of validateCoverageDebt(raw)) {
    out.push(`${filepath}: ${err} (#3189)`);
  }
  return out;
}

/** vbrief_validate hook: validate ``plan.policy.checkResume`` (#3189). */
export function validateCheckResumeOnPlan(plan: unknown, filepath: string): string[] {
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return [];
  }
  const policy = readPlanPolicy(plan);
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    return [];
  }
  if (!("checkResume" in (policy as JsonObject))) {
    return [];
  }
  const raw = (policy as JsonObject).checkResume;
  if (raw === null) {
    return [`${filepath}: plan.policy.checkResume must be an object; got null (#3189)`];
  }
  const out: string[] = [];
  for (const err of validateCheckResume(raw)) {
    out.push(`${filepath}: ${err} (#3189)`);
  }
  return out;
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
  try {
    errors.push(...validateForgeOutageRetryMinutesOnPlan(plan, filepath));
  } catch {
    /* hook must not break validation */
  }
  try {
    errors.push(...validateProjectInvariantsOnPlan(plan, filepath));
  } catch {
    /* hook must not break validation */
  }
  try {
    errors.push(...validateStalenessTicklerOnPlan(plan, filepath));
  } catch {
    /* hook must not break validation */
  }
  try {
    errors.push(...validateRuntimeAuthorityOnPlan(plan, filepath));
  } catch {
    /* hook must not break validation */
  }
  try {
    errors.push(...validateHostHooksOnPlan(plan, filepath));
  } catch {
    /* hook must not break validation */
  }
  try {
    errors.push(...validateHostSlashCommandsOnPlan(plan, filepath));
  } catch {
    /* hook must not break validation */
  }
  try {
    errors.push(...validateOpenClawProductCommandsOnPlan(plan, filepath));
  } catch {
    /* hook must not break validation */
  }
  try {
    errors.push(...validateCoverageDebtOnPlan(plan, filepath));
    errors.push(...validateCheckResumeOnPlan(plan, filepath));
  } catch {
    /* hook must not break validation */
  }
  return errors;
}
