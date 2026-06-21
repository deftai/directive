import { describe, expect, it } from "vitest";
import { readRepoFile, repoFileExists } from "./helpers.js";

/** Port of tests/content/test_plain_english_ux.py (#1838 #740) */

const interviewSkillText = readRepoFile("skills/deft-directive-interview/SKILL.md");
const interviewStrategyText = readRepoFile("strategies/interview.md");
const uxDocText = readRepoFile("references/plain-english-ux.md");

const MENU_BLOCK_RE = /((?:^[ \t]*\d+\.[^\n]*\n){3,})/gm;
const CANONICAL_PREFACE_TOKENS = ["Red lines", "green lines"] as const;

function extractNumberedMenus(text: string): string[][] {
  const menus: string[][] = [];
  for (const match of text.matchAll(MENU_BLOCK_RE)) {
    const block = match[1];
    const lines = block
      .split("\n")
      .map((ln) => ln.trim())
      .filter(Boolean);
    const numbered = lines.filter((ln) => /^\d+\./.test(ln));
    if (numbered.length >= 3) {
      menus.push(numbered);
    }
  }
  return menus;
}

function approvalMenusFrom(text: string): string[][] {
  return extractNumberedMenus(text).filter((menu) =>
    menu.join(" ").includes("Approve and continue"),
  );
}

describe("test_plain_english_ux", () => {
  describe("TestUXReferenceDoc", () => {
    it("file_exists", () => {
      expect(repoFileExists("references/plain-english-ux.md")).toBe(true);
    });

    it("has_acronym_rule", () => {
      expect(uxDocText.includes("Acronyms") || uxDocText.toLowerCase().includes("acronym")).toBe(
        true,
      );
      expect(uxDocText.toLowerCase()).toContain("first use");
    });

    it("has_approval_menu_rule", () => {
      expect(uxDocText.toLowerCase()).toContain("approval menu");
    });

    it("has_diff_preface_rule", () => {
      const lower = uxDocText.toLowerCase();
      expect(lower).toContain("diff");
      expect(lower).toContain("preface");
    });

    it("discuss_back_final_two_rule", () => {
      const lower = uxDocText.toLowerCase();
      expect(lower).toContain("discuss");
      expect(lower).toContain("back");
      expect(
        lower.includes("final two") ||
          lower.includes("last two") ||
          lower.includes("final two numbered"),
      ).toBe(true);
      expect(uxDocText).toContain("#767");
    });

    it("jargon_rule_present", () => {
      const lower = uxDocText.toLowerCase();
      expect(lower.includes("context note") || lower.includes("plain-english context")).toBe(true);
      expect(lower).toContain("jargon");
    });

    it("framework_justification_rule_present", () => {
      const lower = uxDocText.toLowerCase();
      expect(lower.includes("industry-standard") || lower.includes("modern")).toBe(true);
      expect(lower).toContain("framework");
    });
  });

  describe("TestAcronymOnFirstUseRule", () => {
    it("interview_skill_links_to_ux_doc", () => {
      expect(interviewSkillText).toContain("references/plain-english-ux.md");
    });

    it("interview_skill_calls_out_acronym_rule", () => {
      const lower = interviewSkillText.toLowerCase();
      expect(lower).toContain("acronym");
      expect(lower).toContain("first use");
    });

    it("interview_skill_inlines_prd_expansion", () => {
      expect(interviewSkillText).toContain("Product Requirements Document");
    });
  });

  describe("TestApprovalMenuPresence", () => {
    it("skill_has_prd_approval_menu", () => {
      expect(interviewSkillText).toContain("PRD");
      expect(interviewSkillText).toContain("Approval Menu");
    });

    it("skill_has_spec_approval_menu", () => {
      expect(interviewSkillText).toContain("SPECIFICATION");
      expect(interviewSkillText).toContain("Approval Menu");
    });

    it("strategy_has_prd_approval_menu", () => {
      expect(interviewStrategyText).toContain("PRD Approval Menu");
    });

    it("strategy_has_spec_approval_menu", () => {
      expect(interviewStrategyText).toContain("SPECIFICATION Approval Menu");
    });

    it("menu_has_approve_continue", () => {
      expect(interviewSkillText).toContain("Approve and continue");
    });

    it("menu_has_suggest_changes", () => {
      expect(interviewSkillText).toContain("Suggest changes");
    });

    it("menu_has_edit_yourself", () => {
      expect(interviewSkillText).toContain("Edit yourself");
    });
  });

  describe("TestDiffPrefacePresence", () => {
    it("skill_has_diff_preface_section", () => {
      const lower = interviewSkillText.toLowerCase();
      expect(
        interviewSkillText.includes("Diff-View Preface") || lower.includes("diff-view preface"),
      ).toBe(true);
    });

    it("skill_canonical_preface", () => {
      for (const token of CANONICAL_PREFACE_TOKENS) {
        expect(interviewSkillText).toContain(token);
      }
    });

    it("strategy_prd_diff_preface", () => {
      const prdSection =
        interviewStrategyText
          .split("### PRD Approval Menu")[1]
          ?.split("### SPECIFICATION Structure")[0] ?? "";
      for (const token of CANONICAL_PREFACE_TOKENS) {
        expect(prdSection).toContain(token);
      }
    });

    it("strategy_spec_diff_preface", () => {
      const specSection =
        interviewStrategyText
          .split("### SPECIFICATION Approval Menu")[1]
          ?.split("### Rejected Spec Archival")[0] ?? "";
      for (const token of CANONICAL_PREFACE_TOKENS) {
        expect(specSection).toContain(token);
      }
    });

    it("skill_states_not_an_error", () => {
      const lower = interviewSkillText.toLowerCase();
      expect(lower.includes("nothing here is broken") || lower.includes("not errors")).toBe(true);
    });
  });

  describe("TestDiscussBackFinalTwoOptions", () => {
    it("skill_approval_menus_end_with_discuss_back", () => {
      const menus = approvalMenusFrom(interviewSkillText);
      expect(menus.length).toBeGreaterThan(0);
      for (const menu of menus) {
        expect(menu.length).toBeGreaterThanOrEqual(5);
        expect(menu[menu.length - 2]).toContain("Discuss");
        expect(menu[menu.length - 1]).toContain("Back");
      }
    });

    it("strategy_approval_menus_end_with_discuss_back", () => {
      const menus = approvalMenusFrom(interviewStrategyText);
      expect(menus.length).toBeGreaterThan(0);
      for (const menu of menus) {
        expect(menu.length).toBeGreaterThanOrEqual(5);
        expect(menu[menu.length - 2]).toContain("Discuss");
        expect(menu[menu.length - 1]).toContain("Back");
      }
    });

    it("skill_cross_references_767", () => {
      expect(interviewSkillText).toContain("#767");
    });

    it("strategy_cross_references_767", () => {
      expect(interviewStrategyText).toContain("#767");
    });

    it("ux_doc_canonical_menus_end_with_discuss_back", () => {
      const menus = extractNumberedMenus(uxDocText).filter((menu) =>
        menu.some((line) => line.includes("Approve and continue")),
      );
      expect(menus.length).toBeGreaterThanOrEqual(2);
      for (const menu of menus) {
        expect(menu[menu.length - 2]).toContain("Discuss");
        expect(menu[menu.length - 1]).toContain("Back");
      }
    });
  });
});
