import { describe, expect, it } from "vitest";
import { readRepoFile, repoFileExists } from "./helpers.js";
import { declaredOses, REQUIRED_OSES, skillMdRelPaths } from "./skill-frontmatter.js";

/** Port of tests/content/test_skill_frontmatter.py (#1838 #1530) */

const COMPOSER_PORTING_REF = "references/composer-skill-porting.md";

const REQUIRED_PORTING_MARKERS = [
  "Negative Triggers",
  "Fast Path vs Isolation",
  "Short Chat Expectations",
  "references/",
  "Do NOT trigger on",
  "--body-file",
] as const;

describe("test_skill_frontmatter", () => {
  it("skill_frontmatter_discovery_found_files", () => {
    expect(skillMdRelPaths().length).toBeGreaterThan(0);
  });

  it("composer_porting_reference_exists", () => {
    expect(repoFileExists(COMPOSER_PORTING_REF)).toBe(true);
  });

  it.each(
    REQUIRED_PORTING_MARKERS,
  )("composer_porting_reference_covers_required_topics %s", (marker) => {
    const text = readRepoFile(COMPOSER_PORTING_REF);
    expect(text).toContain(marker);
  });

  it.each(
    skillMdRelPaths().filter((p) => declaredOses(p) !== null),
  )("skill_os_frontmatter_includes_all_supported_oses %s", (skillPath) => {
    const tokens = declaredOses(skillPath);
    expect(tokens).not.toBeNull();
    const missing = [...REQUIRED_OSES].filter((os) => !tokens?.includes(os));
    expect(missing).toEqual([]);
  });
});
