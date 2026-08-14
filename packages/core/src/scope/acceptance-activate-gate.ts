/**
 * scope:activate refuses acceptance-shaped narratives without plan.acceptance (#3334).
 *
 * Agents author Test / AcceptanceCriteria / Verification prose in narratives
 * and then skip the executable plan.acceptance block. Activation fails closed
 * with one remediation: stamp plan.acceptance via clause derivation.
 */

import { validatePlanAcceptance } from "../product-first-done-gate/acceptance.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

const ACCEPTANCE_SHAPED_KEYS = new Set(["test", "acceptancecriteria", "verification"]);

function normalizeNarrativeKey(key: string): string {
  return key.replace(/[\s_-]+/g, "").toLowerCase();
}

export interface AcceptanceActivateHit {
  readonly key: string;
}

export interface AcceptanceActivateGateResult {
  readonly ok: boolean;
  readonly message: string;
  readonly hits: readonly AcceptanceActivateHit[];
}

/** Narrative keys that look like authored acceptance (non-empty string values). */
export function collectAcceptanceShapedNarrativeKeys(
  narratives: Record<string, unknown>,
): AcceptanceActivateHit[] {
  const hits: AcceptanceActivateHit[] = [];
  for (const key of Object.keys(narratives)) {
    if (!ACCEPTANCE_SHAPED_KEYS.has(normalizeNarrativeKey(key))) {
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
  const keys = hits.map((h) => h.key).join(", ");
  return {
    ok: false,
    message:
      `Refusing activate: narratives contain acceptance-shaped keys (${keys}) ` +
      `but plan.acceptance is absent (#3334). Stamp plan.acceptance via clause derivation ` +
      `(scope:activate / scope:promote runs #3323, or task issue:ingest) — ` +
      `the criteria are in the wrong, non-executable field.`,
    hits,
  };
}
