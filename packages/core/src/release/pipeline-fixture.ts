import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReleaseSeams } from "./types.js";

/** Seed a real on-disk project root for pipeline write-path tests (#2470). */
export function seedReleaseProjectDir(changelog = `## [Unreleased]\n\n### Added\n- x\n`): string {
  const dir = mkdtempSync(join(tmpdir(), "release-proj-"));
  writeFileSync(join(dir, "CHANGELOG.md"), changelog, "utf8");
  writeFileSync(join(dir, "ROADMAP.md"), "# Roadmap\n", "utf8");
  return dir;
}

/**
 * Default unpaid-ledger seam for pipeline tests that use --skip-ci with a
 * fixture citation. Production unpaid refusal is covered by dedicated tests;
 * these seams keep branch/tag/release fixtures from failing closed as UNKNOWN.
 */
export const paidSkipCiLedgerSeam: NonNullable<ReleaseSeams["probeSkipCiIncidentLedger"]> = () => ({
  unpaid: [],
});

export { passReleaseInputs } from "./release-input.js";
