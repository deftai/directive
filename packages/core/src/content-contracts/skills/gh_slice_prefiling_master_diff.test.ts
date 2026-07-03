import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers.js";

/**
 * #1102: the canonical issue-filing skill (deft-directive-gh-slice) MUST carry a
 * `!` MUST rule + `⊗` MUST NOT anti-pattern requiring a pre-filing
 * `git ls-tree origin/master` existence check before an issue proposes ADDING a
 * file, cross-referenced from the refinement skill's Phase 1 filing step and
 * recorded in the lessons surface.
 */

describe("test_gh_slice_prefiling_master_diff", () => {
  it("gh_slice_step5_prefiling_rule_present", () => {
    const text = readRepoFile("skills/deft-directive-gh-slice/SKILL.md");
    expect(text).toContain("### Step 5: Create the GitHub issues");
    const expectedTokens = [
      "Pre-filing master-diff check (#1102)",
      "git ls-tree origin/master -- <path>",
      "gh api repos/{owner}/{repo}/contents/{path}",
      "ADDING",
      "DELTA",
    ];
    for (const tok of expectedTokens) {
      expect(text).toContain(tok);
    }
  });

  it("gh_slice_prefiling_anti_pattern_present", () => {
    const text = readRepoFile("skills/deft-directive-gh-slice/SKILL.md");
    expect(text).toContain("## Anti-Patterns");
    expect(text).toContain(
      "File an issue proposing to add a file or directory that already exists on master",
    );
    // Recurrence record must be cited on the anti-pattern.
    for (const issueRef of ["#1099", "#1100", "#1070"]) {
      expect(text).toContain(issueRef);
    }
  });

  it("refinement_phase1_cross_references_prefiling_rule", () => {
    const text = readRepoFile("skills/deft-directive-refinement/SKILL.md");
    expect(text).toContain("## Phase 1 -- Ingest");
    expect(text).toContain("Pre-filing master-diff check (#1102)");
    expect(text).toContain("../deft-directive-gh-slice/SKILL.md");
  });

  it("lessons_surface_records_recurrence", () => {
    const text = readRepoFile("meta/lessons.md");
    expect(text).toContain("Pre-filing master-diff check before proposing to add a file");
    expect(text).toContain("#1102");
    expect(text).toContain("skills/deft-directive-gh-slice/SKILL.md");
  });
});
