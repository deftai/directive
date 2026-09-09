/**
 * Auto-stamp catalog chip after a completed-arc record (#4298).
 *
 * Recut vs implement is a token on the successor lean, not a chip. Bind path 1
 * remaining-set-replaces ingest-ready once the record exists. This module does
 * not classify comments as successor leans.
 */

import type { DesignCritiqueCatalogChip } from "./exclusive-chip.js";

/** Nine spellings: zero to two asterisks counted independently on each side. */
const RECUT_TOKEN_RE = /(?:^|\n)\s*\*{0,2}Recut:\*{0,2}/;

export function leanCarriesRecutToken(body: string): boolean {
  return RECUT_TOKEN_RE.test(body);
}

/**
 * Chip for #3640 auto-stamp / bind path 2 after operator confirm.
 * Record present -> ingest-ready. Recut: is not a chip selector.
 */
export function resolveAutoStampCatalogChip(
  _successorLeanBody?: string,
): DesignCritiqueCatalogChip {
  return "design-critique:ingest-ready";
}
