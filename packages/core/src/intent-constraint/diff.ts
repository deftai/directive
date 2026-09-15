/**
 * Diff HEAD facts against merge-base facts (#4541).
 */
import type { ConstraintFact, MintConstraint, SurfaceSnapshot } from "./types.js";

export interface FactDelta {
  readonly path: string;
  readonly fact: ConstraintFact;
}

export function newFacts(
  base: readonly SurfaceSnapshot[],
  head: readonly SurfaceSnapshot[],
): FactDelta[] {
  const baseKeys = new Set<string>();
  for (const surface of base) {
    for (const fact of surface.facts) {
      baseKeys.add(`${surface.path}\0${fact.kind}\0${fact.id}`);
    }
  }
  const out: FactDelta[] = [];
  for (const surface of head) {
    for (const fact of surface.facts) {
      const key = `${surface.path}\0${fact.kind}\0${fact.id}`;
      if (!baseKeys.has(key)) out.push({ path: surface.path, fact });
    }
  }
  return out;
}

export function uncoveredDeltas(
  deltas: readonly FactDelta[],
  constraints: readonly MintConstraint[],
): FactDelta[] {
  return deltas.filter((delta) => {
    if (delta.fact.kind === "numeric-const") {
      const value = delta.fact.value;
      if (value === undefined || value.length === 0) return true;
      return !constraints.some((c) => c.value === value);
    }
    return !constraints.some((c) => c.rejectionScope.length > 0);
  });
}
