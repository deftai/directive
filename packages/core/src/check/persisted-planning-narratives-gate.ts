/**
 * Check-surface first-ship bar for empty PROJECT-DEFINITION planning
 * narratives (#5176 Prefer-A).
 *
 * Missing PROJECT-DEFINITION is not this bar (setup/init owns presence).
 * Empty Overview+tech stack after a seeded PD fails closed.
 */
import {
  EMPTY_PLANNING_NARRATIVES_CAUSE,
  evaluatePersistedPlanningNarratives,
  type PersistedPlanningNarrativesResult,
} from "../project/persisted-planning-narratives.js";

export const CHECK_EMPTY_PLANNING_NARRATIVES_GATE_ID = "verify:persisted-planning-narratives";

/** True when check must refuse for all-empty tracked PD planning narratives. */
export function checkRejectsEmptyPlanningNarratives(
  result: PersistedPlanningNarrativesResult,
): result is Extract<PersistedPlanningNarrativesResult, { ok: false; code: 1 }> {
  return !result.ok && result.code === 1 && result.cause === EMPTY_PLANNING_NARRATIVES_CAUSE;
}

/** Evaluate the project root for the check-surface Prefer-A bar. */
export function evaluateCheckPersistedPlanningNarratives(
  projectRoot: string,
): PersistedPlanningNarrativesResult {
  return evaluatePersistedPlanningNarratives(projectRoot);
}
