/**
 * Promote-time bind of derived clauses to approved file_scope members (#4008).
 *
 * Walk-time basename matching is refused (#3835). This gate copies an exact
 * declared member onto the clause, or refuses the lifecycle write.
 */

import {
  bindClausesToDeclaredScope,
  type ClauseFileScopeBindResult,
  readAcceptanceClauses,
  readDeclaredArtifactScope,
} from "../verify-ac/clauses.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function evaluatePromoteClauseFileScopeBind(
  plan: Record<string, unknown>,
): ClauseFileScopeBindResult {
  return bindClausesToDeclaredScope(
    readAcceptanceClauses(plan.acceptance),
    readDeclaredArtifactScope(plan),
  );
}

/** Derived stamps only: stated/legacy clauses are not this gate (#4008 Greptile P1). */
export function shouldApplyPromoteClauseFileScopeBind(
  plan: Record<string, unknown>,
  derivationApplied: boolean,
): boolean {
  if (derivationApplied) {
    return true;
  }
  const acceptance = asRecord(plan.acceptance);
  return acceptance?.source_rung === "derived";
}

export function applyPromoteClauseFileScopeBind(
  plan: Record<string, unknown>,
): ClauseFileScopeBindResult {
  const result = evaluatePromoteClauseFileScopeBind(plan);
  if (!result.ok || !result.changed) {
    return result;
  }
  const acceptance = asRecord(plan.acceptance);
  if (acceptance === null || !Array.isArray(acceptance.clauses)) {
    return result;
  }
  let nextBound = 0;
  acceptance.clauses = acceptance.clauses.map((entry) => {
    const row = asRecord(entry);
    if (row === null) {
      return entry;
    }
    const text = typeof row.text === "string" ? row.text.trim() : "";
    if (text.length === 0) {
      return entry;
    }
    const bound = result.clauses[nextBound];
    nextBound += 1;
    if (bound === undefined) {
      return entry;
    }
    const stamped: Record<string, unknown> = {
      ...row,
      artifact_path: bound.artifact_path,
    };
    if (bound.readings !== undefined) {
      stamped.readings = bound.readings.map((reading) => ({
        text: reading.text,
        artifact_path: reading.artifact_path,
      }));
      stamped.chosen_reading = bound.chosen_reading ?? 0;
    }
    return stamped;
  });
  plan.acceptance = acceptance;
  return result;
}
