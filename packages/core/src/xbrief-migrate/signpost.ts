import { detectLegacyVbriefLayout, detectXbriefConvergence } from "./detect.js";

/** Operator guidance for the TS-native xbrief rename (#2034 / #2110). */
export function xbriefMigrationGuidance(): string {
  return "Run `deft migrate:xbrief` (or `task migrate:xbrief`) to convert vbrief/ to xbrief/ safely.";
}

/**
 * One-line doctor / ritual signpost mirroring `renderPrecutoverLine` (#2110),
 * reporting an unambiguous convergence state (#2270). A migrated project reads
 * as `xbrief active` plus either `vbrief legacy marker` or `vbrief removed`; a
 * stray empty legacy root is called out as a pending convergence rather than a
 * generic "run migrate" dead end — never a dual-empty-root ambiguity.
 */
export function renderXbriefMigrationLine(projectRoot: string): string {
  const convergence = detectXbriefConvergence(projectRoot);

  // Converged: legacy vbrief/ retained for read-compat behind an explicit marker.
  if (convergence.state === "xbrief-marker") {
    return "xBrief migration: converged -- xbrief active, vbrief legacy marker (read-compat).";
  }

  // Ambiguous dual-empty root: canonical xbrief/ (or none) plus a stray empty vbrief/.
  if (convergence.state === "empty-vbrief") {
    return `xBrief migration: converge pending -- xbrief active, empty legacy vbrief/ present. ${xbriefMigrationGuidance()}`;
  }

  const { legacyLayout, reasons } = detectLegacyVbriefLayout(projectRoot);
  if (!legacyLayout) {
    return "xBrief migration: none -- xbrief active, vbrief removed.";
  }
  const maxReasons = 3;
  const shown = reasons.slice(0, maxReasons);
  const remainder = reasons.length - shown.length;
  const summary = shown.join("; ").replace(/\r?\n/g, " ");
  const tail = remainder > 0 ? `${summary}; …and ${remainder} more marker(s)` : summary;
  return `xBrief migration: legacy vbrief layout detected -- ${tail}. ${xbriefMigrationGuidance()}`;
}
