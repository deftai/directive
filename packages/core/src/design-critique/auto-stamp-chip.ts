/**
 * Auto-stamp catalog chip from a closed Lean-family line-start (#4205).
 *
 * Recut vs implement is a token on the successor lean, not English. Same
 * wrapping as `Lean:` (zero to two asterisks on each side). Absence of the
 * token is the implement-bound chip. This module does not classify comments
 * as successor leans.
 */

import type { DesignCritiqueCatalogChip } from "./exclusive-chip.js";

/** Nine spellings: zero to two asterisks counted independently on each side. */
const RECUT_TOKEN_RE = /(?:^|\n)\s*\*{0,2}Recut:\*{0,2}/;

export function leanCarriesRecutToken(body: string): boolean {
  return RECUT_TOKEN_RE.test(body);
}

/**
 * Chip for #3640 auto-stamp / bind path 2 after operator confirm.
 * Recut token present → recut-needed. Otherwise triage-ready.
 */
export function resolveAutoStampCatalogChip(successorLeanBody: string): DesignCritiqueCatalogChip {
  return leanCarriesRecutToken(successorLeanBody)
    ? "design-critique:recut-needed"
    : "design-critique:triage-ready";
}
