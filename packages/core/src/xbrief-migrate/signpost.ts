import { detectXbriefConvergence } from "./detect.js";

/** Operator guidance for the TS-native xbrief rename (#2034 / #2110). */
export function xbriefMigrationGuidance(): string {
  return "Run `deft migrate:xbrief` (or `task migrate:xbrief`) to convert vbrief/ to xbrief/ safely.";
}

/**
 * One-line doctor / ritual signpost mirroring `renderPrecutoverLine` (#2110),
 * reporting an unambiguous convergence state (#2270 / #2112). As of #2112
 * (0.73.0 MINOR), the legacy vbrief read path is removed; the `legacy-only` and
 * `dual-populated` states are still reported here so the doctor can direct
 * unmigrated-project operators to `deft migrate:xbrief` before the engine runs.
 */
export function renderXbriefMigrationLine(projectRoot: string): string {
  const convergence = detectXbriefConvergence(projectRoot);

  // Converged: legacy vbrief/ retained for read-compat behind an explicit marker.
  if (convergence.state === "xbrief-marker") {
    return "xBrief migration: converged -- xbrief active, vbrief legacy marker (read-compat).";
  }

  // Ambiguous: canonical xbrief/ (or none) plus a stray empty vbrief/.
  if (convergence.state === "empty-vbrief") {
    return `xBrief migration: converge pending -- xbrief active, empty legacy vbrief/ present. ${xbriefMigrationGuidance()}`;
  }

  // Unmigrated: only vbrief/ found, or both roots populated without a marker.
  if (convergence.state === "legacy-only" || convergence.state === "dual-populated") {
    return `xBrief migration: migrate required -- ${convergence.state === "legacy-only" ? "only vbrief/ found, no xbrief/ layout" : "both vbrief/ and xbrief/ found without a migration marker"}. ${xbriefMigrationGuidance()}`;
  }

  // Fully migrated: xbrief active, no legacy vbrief/ present (or empty root with no content).
  return "xBrief migration: none -- xbrief active, vbrief removed.";
}
