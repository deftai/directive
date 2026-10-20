import { legacyClauseIdSignpostSuffix } from "./clause-ids.js";
import { detectXbriefConvergence } from "./detect.js";

/** Operator guidance for lifecycle migration (AC8.9 / F-017): install-management owns upgrade. */
export function xbriefMigrationGuidance(): string {
  return "Run `directive upgrade` to migrate vbrief/ to current xbrief/ safely.";
}

/**
 * One-line doctor / ritual signpost mirroring `renderPrecutoverLine` (#2110),
 * reporting an unambiguous convergence state (#2270 / #2112). As of #2112
 * (0.73.0 MINOR), the legacy vbrief read path is removed; the `legacy-only` and
 * `dual-populated` states are still reported here so the doctor can direct
 * unmigrated-project operators to `directive upgrade` (AC8.9 / F-017).
 */
export function renderXbriefMigrationLine(projectRoot: string): string {
  const convergence = detectXbriefConvergence(projectRoot);

  let line: string;
  // Converged: legacy vbrief/ retained for read-compat behind an explicit marker.
  if (convergence.state === "xbrief-marker") {
    line = "xBrief migration: converged -- xbrief active, vbrief legacy marker (read-compat).";
  } else if (convergence.state === "empty-vbrief") {
    // Ambiguous: canonical xbrief/ (or none) plus a stray empty vbrief/.
    const xbriefBit = convergence.xbriefHasContent ? "xbrief active" : "xbrief absent or empty";
    line = `xBrief migration: converge pending -- ${xbriefBit}, empty legacy vbrief/ present. ${xbriefMigrationGuidance()}`;
  } else if (convergence.state === "legacy-only" || convergence.state === "dual-populated") {
    // Unmigrated: only vbrief/ found, or both roots populated without a marker.
    line = `xBrief migration: migrate required -- ${convergence.state === "legacy-only" ? "only vbrief/ found, no xbrief/ layout" : "both vbrief/ and xbrief/ found without a migration marker"}. ${xbriefMigrationGuidance()}`;
  } else {
    // Fully migrated: xbrief active, no legacy vbrief/ present (or empty root with no content).
    line = "xBrief migration: none -- xbrief active, vbrief removed.";
  }
  const leftover = legacyClauseIdSignpostSuffix(projectRoot);
  return leftover.length > 0 ? `${line} ${leftover}` : line;
}
