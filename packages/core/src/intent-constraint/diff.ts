/**
 * Diff HEAD facts against merge-base facts (#4541).
 *
 * Matching policy (#3452): a mint row is one (value, unit, rejectionScope)
 * approval. Numeric-const matches value 1:1. Throw/reject/abort matches a
 * nonempty rejectionScope 1:1. Unit is human-authored on the mint; source
 * literals have no unit. Path is not a mint field this ship.
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
  const slots = constraints.map((c) => ({
    value: c.value,
    unit: c.unit,
    rejectionScope: c.rejectionScope,
    numericUsed: false,
    rejectionUsed: false,
    numericPath: undefined as string | undefined,
    rejectionPath: undefined as string | undefined,
  }));
  const leftover: FactDelta[] = [];
  for (const delta of deltas) {
    if (delta.fact.kind === "numeric-const") {
      const value = delta.fact.value;
      if (value === undefined || value.length === 0) {
        leftover.push(delta);
        continue;
      }
      const slot = slots.find(
        (c) =>
          !c.numericUsed &&
          c.value === value &&
          c.unit.length > 0 &&
          (c.rejectionPath === undefined || c.rejectionPath === delta.path),
      );
      if (slot === undefined) leftover.push(delta);
      else {
        slot.numericUsed = true;
        slot.numericPath = delta.path;
      }
      continue;
    }
    const slot = slots.find(
      (c) =>
        !c.rejectionUsed &&
        c.rejectionScope.length > 0 &&
        (c.numericPath === undefined || c.numericPath === delta.path),
    );
    if (slot === undefined) leftover.push(delta);
    else {
      slot.rejectionUsed = true;
      slot.rejectionPath = delta.path;
    }
  }
  return leftover;
}
