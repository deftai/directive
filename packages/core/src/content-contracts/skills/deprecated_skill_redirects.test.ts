import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEPRECATED_SKILL_REDIRECT_STUBS,
  readRepoFile,
  repoFileExists,
  resolveRepoPath,
} from "./helpers.js";

/** Port of tests/content/test_deprecated_skill_redirects.py (#1838 #1530) */

const REDIRECT_STUBS: Array<[string, string]> = [
  ["deft-sync", "deft-directive-sync"],
  ["deft-setup", "deft-directive-setup"],
  ["deft-build", "deft-directive-build"],
  ["deft-review-cycle", "deft-directive-review-cycle"],
  ["deft-roadmap-refresh", "deft-directive-refinement"],
  ["deft-swarm", "deft-directive-swarm"],
  ["deft-pre-pr", "deft-directive-pre-pr"],
  ["deft-interview", "deft-directive-interview"],
];

const STUB_SENTINEL = "<!-- deft:deprecated-skill-redirect -->";
const QUICKSTART_REDIRECT_PHRASE = "deft/QUICK-START.md";

describe("test_deprecated_skill_redirects", () => {
  describe.each(REDIRECT_STUBS)("%s stub", (oldName, newName) => {
    const stubPath = `skills/${oldName}/SKILL.md`;

    it("stub_file_exists", () => {
      expect(repoFileExists(stubPath)).toBe(true);
    });

    it("stub_has_sentinel", () => {
      const content = readRepoFile(stubPath);
      expect(content).toContain(STUB_SENTINEL);
      expect(content.slice(0, 200)).toContain(STUB_SENTINEL);
    });

    it("stub_points_at_quickstart", () => {
      expect(readRepoFile(stubPath)).toContain(QUICKSTART_REDIRECT_PHRASE);
    });

    it("stub_names_replacement_skill", () => {
      expect(readRepoFile(stubPath)).toContain(newName);
    });
  });

  it("no_extra_bare_deft_redirect_stubs", () => {
    const known = new Set(DEPRECATED_SKILL_REDIRECT_STUBS);
    const found = new Set(
      readdirSync(resolveRepoPath("skills"), { withFileTypes: true })
        .filter(
          (d) =>
            d.isDirectory() && d.name.startsWith("deft-") && !d.name.startsWith("deft-directive-"),
        )
        .map((d) => d.name),
    );
    const unexpected = [...found].filter((x) => !known.has(x));
    expect(unexpected).toEqual([]);
  });

  it("readme_has_upgrade_banner", () => {
    expect(readRepoFile("README.md")).toContain("UPGRADING.md");
  });

  it("readme_banner_has_agent_rule", () => {
    const content = readRepoFile("README.md");
    expect(content.includes("Read [UPGRADING.md]") || content.includes("Read UPGRADING.md")).toBe(
      true,
    );
  });
});
