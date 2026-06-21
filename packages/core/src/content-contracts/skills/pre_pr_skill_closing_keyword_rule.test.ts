import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers.js";

/** Port of tests/content/test_pre_pr_skill_closing_keyword_rule.py (#1838 #1530) */

function _read(rel) {
  return readRepoFile(rel);
}

describe("test_pre_pr_skill_closing_keyword_rule", () => {
  it("pre_pr_skill_phase4_rule_present", () => {
    const text = readRepoFile("skills/deft-directive-pre-pr/SKILL.md");
    expect(text).toContain("### Phase 4 -- Diff");
    const expected_tokens = [
      "task pr:check-closing-keywords",
      "(#737)",
      "--body-file",
      "--commits-file",
      "negation",
      "quotation",
      "code-block",
      "--allow-known-false-positives",
    ];
    for (const tok of expected_tokens) {
      expect(text).toContain(tok);
    }
  });
  it("pre_pr_skill_phase4_recurrence_record_present", () => {
    const text = readRepoFile("skills/deft-directive-pre-pr/SKILL.md");
    for (const issue_ref of ["#167", "#697", "#401", "#700", "#735"]) {
      expect(text).toContain(issue_ref);
    }
  });
  it("pre_pr_skill_phase4_anti_pattern_present", () => {
    const text = readRepoFile("skills/deft-directive-pre-pr/SKILL.md");
    expect(text).toContain("## Anti-Patterns");
    expect(text).toContain("Skip `task pr:check-closing-keywords`");
  });
  it("swarm_skill_phase6_layer0_cross_reference_present", () => {
    const text = readRepoFile("skills/deft-directive-swarm/SKILL.md");
    expect(text).toContain("### Step 1: Merge");
    expect(text).toContain("Layer 0");
    expect(text).toContain("Layer 3");
    expect(text).toContain("skills/deft-directive-pre-pr/SKILL.md");
    expect(text).toContain("pr:check-closing-keywords");
  });
});
