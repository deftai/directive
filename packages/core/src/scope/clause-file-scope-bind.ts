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
  const byId = new Map(result.clauses.map((clause) => [clause.id, clause]));
  acceptance.clauses = acceptance.clauses.map((entry) => {
    const row = asRecord(entry);
    if (row === null || typeof row.id !== "number") {
      return entry;
    }
    const bound = byId.get(row.id);
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
