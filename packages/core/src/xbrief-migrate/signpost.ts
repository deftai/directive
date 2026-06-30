import { detectLegacyVbriefLayout } from "./detect.js";

/** Operator guidance for the TS-native xbrief rename (#2034 / #2110). */
export function xbriefMigrationGuidance(): string {
  return "Run `deft migrate:xbrief` (or `task migrate:xbrief`) to convert vbrief/ to xbrief/ safely.";
}

/** One-line doctor / ritual signpost mirroring `renderPrecutoverLine` (#2110). */
export function renderXbriefMigrationLine(projectRoot: string): string {
  const { legacyLayout, reasons } = detectLegacyVbriefLayout(projectRoot);
  if (!legacyLayout) {
    return "xBrief migration: none -- project is on the xbrief layout.";
  }
  const maxReasons = 3;
  const shown = reasons.slice(0, maxReasons);
  const remainder = reasons.length - shown.length;
  const summary = shown.join("; ").replace(/\r?\n/g, " ");
  const tail = remainder > 0 ? `${summary}; …and ${remainder} more marker(s)` : summary;
  return `xBrief migration: legacy vbrief layout detected -- ${tail}. ${xbriefMigrationGuidance()}`;
}
