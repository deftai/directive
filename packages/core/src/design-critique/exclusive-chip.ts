import type { LabelClient } from "../vbrief-reconcile/types.js";

/** Closed catalog. Last chip wins. Not an open `design-critique:*` glob. */
export const DESIGN_CRITIQUE_CATALOG_CHIPS = [
  "design-critique:mechanism-shaped",
  "design-critique:triage-ready",
] as const;

export type DesignCritiqueCatalogChip = (typeof DESIGN_CRITIQUE_CATALOG_CHIPS)[number];

const CATALOG = new Set<string>(DESIGN_CRITIQUE_CATALOG_CHIPS);

export function isDesignCritiqueCatalogChip(name: string): name is DesignCritiqueCatalogChip {
  return CATALOG.has(name);
}

/**
 * Remaining-set replace: GET current, drop the other catalog names, keep other
 * facets, then PUT/PATCH this list. One write. No DELETE-then-POST window.
 */
export function remainingSetAfterDesignCritiqueChip(
  current: readonly string[],
  nextChip: string,
): string[] {
  if (!isDesignCritiqueCatalogChip(nextChip)) {
    throw new Error(
      `not a design-critique catalog chip: ${nextChip} (closed set: ${DESIGN_CRITIQUE_CATALOG_CHIPS.join(", ")})`,
    );
  }
  const remaining = current.filter((name) => !CATALOG.has(name));
  remaining.push(nextChip);
  return remaining;
}

/** Delta for LabelClient.apply (one add+remove mutation). */
export function designCritiqueChipApplyDelta(
  current: readonly string[],
  nextChip: string,
): { add: string[]; remove: string[] } {
  if (!isDesignCritiqueCatalogChip(nextChip)) {
    throw new Error(
      `not a design-critique catalog chip: ${nextChip} (closed set: ${DESIGN_CRITIQUE_CATALOG_CHIPS.join(", ")})`,
    );
  }
  const currentSet = new Set(current);
  const remove = DESIGN_CRITIQUE_CATALOG_CHIPS.filter(
    (name) => name !== nextChip && currentSet.has(name),
  );
  const add = currentSet.has(nextChip) ? [] : [nextChip];
  return { add, remove };
}

/**
 * Exclusive catalog-chip write via LabelClient.apply. GET current, then one
 * apply(add, remove). Does not PUT a naive full wipe.
 */
export function applyDesignCritiqueCatalogChip(
  client: LabelClient,
  repo: string,
  issueNumber: number,
  nextChip: string,
): { remaining: string[]; add: readonly string[]; remove: readonly string[] } {
  const current = client.fetchLabels(repo, issueNumber);
  const { add, remove } = designCritiqueChipApplyDelta(current, nextChip);
  if (add.length > 0 || remove.length > 0) {
    client.apply(repo, issueNumber, add, remove);
  }
  return {
    remaining: remainingSetAfterDesignCritiqueChip(current, nextChip),
    add,
    remove,
  };
}
