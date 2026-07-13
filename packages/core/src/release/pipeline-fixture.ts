import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Seed a real on-disk project root for pipeline write-path tests (#2470). */
export function seedReleaseProjectDir(changelog = `## [Unreleased]\n\n### Added\n- x\n`): string {
  const dir = mkdtempSync(join(tmpdir(), "release-proj-"));
  writeFileSync(join(dir, "CHANGELOG.md"), changelog, "utf8");
  writeFileSync(join(dir, "ROADMAP.md"), "# Roadmap\n", "utf8");
  return dir;
}
