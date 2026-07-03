/**
 * Neutral leaf constants for the init-deposit surface.
 *
 * Kept dependency-free so both `scaffold.ts` and `hygiene.ts` can import the
 * canonical install root without completing a module dependency cycle
 * (scaffold needs hygiene's allowlist ERE; hygiene needs the install root).
 */

/** Canonical vendored framework install root, relative to the project root. */
export const CANONICAL_INSTALL_ROOT = ".deft/core";

/** Minimal output sink shared by the init-deposit surface. */
export interface InitDepositIo {
  printf: (text: string) => void;
}
