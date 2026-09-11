/**
 * Auto-stamp catalog chip after a completed-arc record (#4298).
 *
 * Spec-path vs body-normative is a token on the successor lean, not a chip.
 * Bind path 1 remaining-set-replaces ingest-ready once the record exists. This
 * module does not classify comments as successor leans.
 */

import { classifyPosition } from "./citation-grammar.js";
import type { DesignCritiqueCatalogChip } from "./exclusive-chip.js";

/**
 * Path-selector token. Taught spelling is Spec-path:. Recut: is a permanent
 * alias. Nine spellings each: zero to two asterisks independently on each side.
 */
const SPEC_PATH_TOKEN_RE = /(?:^|\n)\s*\*{0,2}(?:Spec-path|Recut):\*{0,2}/g;

/** Ingest path selector: Spec-path: or legacy Recut:, Lean-family wrapping. */
export function leanCarriesSpecPathToken(body: string): boolean {
  const re = new RegExp(SPEC_PATH_TOKEN_RE.source, SPEC_PATH_TOKEN_RE.flags);
  for (const match of body.matchAll(re)) {
    if (classifyPosition(body, match.index ?? 0) === null) {
      return true;
    }
  }
  return false;
}

/** Same predicate as leanCarriesSpecPathToken. Recut: remains a permanent alias. */
export function leanCarriesRecutToken(body: string): boolean {
  return leanCarriesSpecPathToken(body);
}

/**
 * Chip for #3640 auto-stamp / bind path 2 after operator confirm.
 * Record present -> ingest-ready. Spec-path: is not a chip selector.
 */
export function resolveAutoStampCatalogChip(
  _successorLeanBody?: string,
): DesignCritiqueCatalogChip {
  return "design-critique:ingest-ready";
}
