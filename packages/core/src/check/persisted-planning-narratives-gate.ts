/**
 * Check-surface first-ship bar for empty PROJECT-DEFINITION planning
 * narratives (#5176 Prefer-A).
 *
 * Missing PROJECT-DEFINITION is not this bar (setup/init owns presence).
 * Bare empty Overview+tech stack without product-mutation evidence stays
 * legal (scaffold / Process-only / greenfield smoke). Refuse only when a
 * durable product-mutation completion marker is present (or unreadable)
 * and every tracked planning field is empty/whitespace — mirror #4544.
 * Setup Phase 2 `verify:persisted-planning-narratives` stays unconditional.
 */
import {
  EMPTY_PLANNING_NARRATIVES_CAUSE,
  evaluatePersistedPlanningNarratives,
  type PersistedPlanningNarrativesResult,
} from "../project/persisted-planning-narratives.js";
import {
  lookupProductMutationCompletion,
  type ProductMutationCompletionLookup,
} from "./product-mutation-completion.js";

export const CHECK_EMPTY_PLANNING_NARRATIVES_GATE_ID = "verify:persisted-planning-narratives";

export interface CheckPersistedPlanningNarrativesSeams {
  /** Test seam: force product-mutation lookup; skips durable-marker read. */
  readonly productMutationLookup?: ProductMutationCompletionLookup;
}

/** True when check must refuse for all-empty tracked PD planning narratives. */
export function checkRejectsEmptyPlanningNarratives(
  result: PersistedPlanningNarrativesResult,
  productMutation: ProductMutationCompletionLookup,
): result is Extract<PersistedPlanningNarrativesResult, { ok: false; code: 1 }> {
  if (result.ok || result.code !== 1 || result.cause !== EMPTY_PLANNING_NARRATIVES_CAUSE) {
    return false;
  }
  // Absent marker = scaffold / Process-only — empty seed stays legal on check.
  if (productMutation.kind === "absent") return false;
  // present or unreadable → first-ship / product-mutation completion conjunct.
  return true;
}

/** Evaluate the project root for the check-surface Prefer-A bar. */
export function evaluateCheckPersistedPlanningNarratives(
  projectRoot: string,
  seams: CheckPersistedPlanningNarrativesSeams = {},
): {
  readonly narratives: PersistedPlanningNarrativesResult;
  readonly productMutation: ProductMutationCompletionLookup;
} {
  const narratives = evaluatePersistedPlanningNarratives(projectRoot);
  const productMutation =
    seams.productMutationLookup ?? lookupProductMutationCompletion(projectRoot);
  return { narratives, productMutation };
}
