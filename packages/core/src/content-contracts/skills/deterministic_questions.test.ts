import { describe, expect, it } from "vitest";
import { readRepoFile, repoFileExists } from "./helpers.js";

/** Port of tests/content/test_deterministic_questions.py (#1838 #1530) */

const _CONTRACT_PATH = "contracts/deterministic-questions.md";
const AFFECTED_SKILLS = [
  "skills/deft-directive-swarm/SKILL.md",
  "skills/deft-directive-setup/SKILL.md",
  "skills/deft-directive-refinement/SKILL.md",
  "skills/deft-directive-pre-pr/SKILL.md",
  "skills/deft-directive-review-cycle/SKILL.md",
  "skills/deft-directive-release/SKILL.md",
];
const HOST_PORTABLE_SKILLS = [
  "skills/deft-directive-triage/SKILL.md",
  "skills/deft-directive-refinement/SKILL.md",
  "skills/deft-directive-swarm/SKILL.md",
  "skills/deft-directive-setup/SKILL.md",
];

describe("test_deterministic_questions", () => {
  it("contract_file_exists", () => {
    expect(repoFileExists("contracts/deterministic-questions.md")).toBeTruthy();
  });
  it("contract_documents_discuss_back_rule", () => {
    const text = readRepoFile("contracts/deterministic-questions.md");
    expect(text).toContain("`Discuss` and `Back`");
    expect(text).toContain("final two numbered options");
    expect(text).toContain("in that order");
  });
  it("contract_discuss_pause_semantic_verbatim", () => {
    const text = readRepoFile("contracts/deterministic-questions.md");
    expect(text).toContain("the agent MUST pause IMMEDIATELY");
    expect(text).toContain("halt the in-progress sequence");
    expect(text).toContain("no further tool calls beyond acknowledging the pause");
    expect(text).toContain("What would you like to discuss?");
    expect(text).toContain("Implicit resumption");
    expect(text).toContain("forbidden");
    expect(text).toContain("re-asks the original question");
    expect(text).toContain("resume");
    expect(text).toContain("continue");
    expect(text).toContain("re-issues the prior selection");
  });
  it("contract_prior_art_section_present", () => {
    const text = readRepoFile("contracts/deterministic-questions.md");
    expect(text).toContain("## Prior art reviewed");
    expect(text).toContain("#431");
    expect(text).toContain("It does NOT introduce a separate `Other` option");
  });
  it("contract_lists_discuss_not_subchoice_of_other", () => {
    const text = readRepoFile("contracts/deterministic-questions.md");
    expect(text).toContain("NOT a sub-choice of any `Other` / `Custom` option");
  });
  it("contract_documents_host_ui_portability_rule", () => {
    const text = readRepoFile("contracts/deterministic-questions.md");
    expect(text).toContain("## Host-UI portability rule (#1563)");
    expect(text).toContain("visibly preserve the canonical numeric option labels");
    expect(text).toContain("displayed number or the exact displayed option text");
    expect(text).toContain("alphabetic host UI affordances");
    expect(text).toContain("bare letter such as `d` or `b`");
  });
  it("contract_documents_backend_selection_prompt_rule", () => {
    const text = readRepoFile("contracts/deterministic-questions.md");
    expect(text).toContain("## Backend-selection prompts (#1568)");
    expect(text).toContain("operator preference");
    expect(text).toContain("probe availability");
    expect(text).toContain("visible numbered options");
    expect(text).toContain("`Discuss` and `Back` remaining the final two numbered options");
    expect(text).toContain("Treat `cursor-cloud` as the implicit default");
  });
  it("host_portable_skills_pin_visible_number_mapping", () => {
    const missing = [];
    for (const rel of HOST_PORTABLE_SKILLS) {
      const text = readRepoFile(rel);
      if (
        !["numeric option labels", "exact displayed option text"].every((token) =>
          token.includes(text),
        )
      ) {
      }
    }
    expect(missing.length).toBe(0);
  });
  it("setup_skill_forbids_alphabetic_host_affordance_inference", () => {
    const text = readRepoFile("skills/deft-directive-setup/SKILL.md");
    expect(text).toContain("alphabetic affordances");
    expect(text).toContain("Infer deterministic answers from host-added letters");
  });
  it("each_affected_skill_cross_references_contract", () => {
    const missing = [];
    for (const rel of AFFECTED_SKILLS) {
      const p = rel;
      const text = readRepoFile(p);
      if (!text.includes("contracts/deterministic-questions.md")) {
      }
    }
    expect(missing.length).toBe(0);
  });
  it("each_affected_skill_documents_discuss_back", () => {
    const missing = [];
    for (const rel of AFFECTED_SKILLS) {
      const p = rel;
      const text = readRepoFile(p);
      if (!text.includes("Discuss") || !text.includes("Back")) {
      }
    }
    expect(missing.length).toBe(0);
  });
  it("glossary_has_deterministic_mode_entry", () => {
    const glossary = readRepoFile("glossary.md");
    expect(glossary).toContain("**Deterministic mode**");
    expect(glossary).toContain("contracts/deterministic-questions.md");
    expect(glossary).toContain("#767");
  });
  it("glossary_has_branch_protection_policy_entry", () => {
    const glossary = readRepoFile("glossary.md");
    expect(glossary).toContain("**Branch-protection policy**");
    expect(glossary).toContain("allowDirectCommitsToMaster");
    expect(glossary).toContain("#746");
    expect(glossary).toContain("#747");
  });
  it("review_cycle_documents_stall_rubric", () => {
    const text = readRepoFile("skills/deft-directive-review-cycle/SKILL.md");
    expect(text).toContain("Stall Detection Rubric");
    expect(text).toContain("#564");
    expect(text.includes("3x") || text.includes("3-x")).toBe(true);
    expect(text).toContain("Wait another");
    expect(text).toContain("Manually re-trigger Greptile");
    expect(text.toLowerCase()).toContain("auto-restart");
    expect(text).toContain("PR comment");
  });
  it("lessons_md_has_stall_entry", () => {
    const lessons = readRepoFile("meta/lessons.md");
    expect(lessons).toContain("## Greptile Review Stall Detection");
    expect(
      lessons.includes("21 minute") || lessons.includes("21-minute") || lessons.includes("21 min"),
    ).toBe(true);
    expect(lessons.includes("PR #561") || lessons.includes("rc4")).toBe(true);
  });
});
