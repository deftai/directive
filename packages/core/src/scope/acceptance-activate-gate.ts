/**
 * scope:activate refuses acceptance-shaped narratives without plan.acceptance (#3334).
 *
 * Agents author Test / AcceptanceCriteria / Verification prose in narratives
 * and then skip the executable plan.acceptance block. Activation fails closed
 * with one remediation: stamp plan.acceptance via clause derivation.
 *
 * Prefer-A #4768 residual: active ingress (vbrief-activate writer + already-active
 * revalidation) must land usable acceptance *text* for the DCR consumer. Commands
 * alone do not count. This is a writer/ingress boundary fix — not an extension of
 * transition `zeroClauseDerivationRefusal` / #4984 as the primary remedy.
 */

import { applyClauseDerivationToPlan } from "../intake/clause-derivation.js";
import { validatePlanAcceptance } from "../product-first-done-gate/acceptance.js";
import {
  DECLARED_ACCEPTANCE_NARRATIVE_KEYS,
  formatZeroClauseAcceptanceShapedNotice,
  normalizeAcceptanceNarrativeKey,
  readAcceptanceClauses,
} from "../verify-ac/clauses.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export interface AcceptanceActivateHit {
  readonly key: string;
}

export interface AcceptanceActivateGateResult {
  readonly ok: boolean;
  readonly message: string;
  readonly hits: readonly AcceptanceActivateHit[];
}

export interface ActiveIngressAcceptanceResult {
  readonly ok: boolean;
  readonly message: string;
  /** True when derivation mutated plan.acceptance with usable clauses. */
  readonly applied: boolean;
}

/** Narrative keys that look like authored acceptance (non-empty string values). */
export function collectAcceptanceShapedNarrativeKeys(
  narratives: Record<string, unknown>,
): AcceptanceActivateHit[] {
  const hits: AcceptanceActivateHit[] = [];
  for (const key of Object.keys(narratives)) {
    if (!DECLARED_ACCEPTANCE_NARRATIVE_KEYS.has(normalizeAcceptanceNarrativeKey(key))) {
      continue;
    }
    const value = narratives[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      continue;
    }
    hits.push({ key });
  }
  return hits;
}

/**
 * Fail closed when narratives carry acceptance-shaped keys and plan.acceptance
 * is absent. A stamped (even empty/none_stated) block is enough.
 */
export function evaluateAcceptanceActivateGate(
  plan: Record<string, unknown>,
): AcceptanceActivateGateResult {
  const narratives = asRecord(plan.narratives);
  if (narratives === null) {
    return { ok: true, message: "", hits: [] };
  }
  const hits = collectAcceptanceShapedNarrativeKeys(narratives);
  if (hits.length === 0) {
    return { ok: true, message: "", hits: [] };
  }
  if (plan.acceptance !== undefined && plan.acceptance !== null) {
    const schemaErrors = validatePlanAcceptance(plan.acceptance);
    if (schemaErrors.length > 0) {
      return {
        ok: false,
        message:
          `Refusing activate: plan.acceptance is present but invalid (#3334): ` +
          `${schemaErrors.join("; ")}. Stamp a valid plan.acceptance block ` +
          `via clause derivation (scope:activate / scope:promote runs #3323).`,
        hits,
      };
    }
    return { ok: true, message: "", hits };
  }
  const keys = hits.map((h) => h.key);
  return {
    ok: false,
    message:
      `Refusing activate: narratives contain acceptance-shaped keys (${keys.join(", ")}) ` +
      `but plan.acceptance is absent (#3334). ` +
      `${formatZeroClauseAcceptanceShapedNotice(keys)} ` +
      `Stamp plan.acceptance via clause derivation ` +
      `(scope:activate / scope:promote runs #3323, or task issue:ingest) — ` +
      `the criteria are in the wrong, non-executable field.`,
    hits,
  };
}

function commandCount(acceptance: unknown): number {
  const rec = asRecord(acceptance);
  if (rec === null || !Array.isArray(rec.commands)) {
    return 0;
  }
  return rec.commands.length;
}

/**
 * Active-ingress localization (#4768 Prefer-A): when acceptance is
 * command-present, require usable clause text before the brief may land or
 * remain in active/. Stated commands do not count as DCR acceptance texts.
 * Bare / floor briefs without commands are not this residual shape — leave
 * those to the shipped transition refuse (#4984), not this writer boundary.
 */
export function prepareActiveIngressAcceptance(
  plan: Record<string, unknown>,
  options: { readonly projectRoot: string },
): ActiveIngressAcceptanceResult {
  const hadCommands = commandCount(plan.acceptance) > 0;
  if (!hadCommands) {
    // Not the Windows command-present residual; do not widen into #4984 here.
    return { ok: true, message: "", applied: false };
  }
  const derivation = applyClauseDerivationToPlan(plan, {
    projectRoot: options.projectRoot,
    emitStamp: false,
  });
  if (derivation.applied || readAcceptanceClauses(plan.acceptance).length > 0) {
    return {
      ok: true,
      message: derivation.notice,
      applied: derivation.applied,
    };
  }
  const recovery =
    "Refusing active ingress (#4768 Prefer-A): command-present / clause-text-empty " +
    "acceptance cannot land or remain in active/ under the DCR text oracle. " +
    "Supply list items, test: lines, or acceptance: lines (#4374), then retry. " +
    "Stated commands alone are not acceptance texts.";
  const message = derivation.notice.length > 0 ? `${derivation.notice}\n${recovery}` : recovery;
  return { ok: false, message, applied: false };
}
