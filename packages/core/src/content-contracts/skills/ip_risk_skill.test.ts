import { describe, expect, it } from "vitest";
import { readRepoFile, repoFileExists } from "./helpers.js";

/** Port of tests/content/test_ip_risk_skill.py (#1838 #738) */

const interviewText = readRepoFile("skills/deft-directive-interview/SKILL.md");
const researchText = readRepoFile("strategies/research.md");
const ipRiskText = readRepoFile("references/ip-risk.md");

describe("test_ip_risk_skill", () => {
  describe("TestInterviewSkillIPRisk", () => {
    it("ip_risk_probe_section_present", () => {
      expect(
        interviewText.includes("IP Risk Probe") ||
          interviewText.toLowerCase().includes("ip risk probe"),
      ).toBe(true);
    });

    it("references_ip_risk_doc", () => {
      expect(interviewText).toContain("references/ip-risk.md");
    });

    it("references_detect_ip_terms", () => {
      expect(interviewText).toContain("detect_ip_terms");
    });

    it("monetization_intent_question_called_out", () => {
      const lower = interviewText.toLowerCase();
      expect(lower.includes("monetization-intent") || lower.includes("monetization intent")).toBe(
        true,
      );
    });

    it("personal_vs_commercial_branching", () => {
      const lower = interviewText.toLowerCase();
      expect(lower).toContain("personal");
      expect(lower).toContain("commercial");
    });

    it("lawyer_consultation_non_optional", () => {
      const lower = interviewText.toLowerCase();
      expect(lower).toContain("lawyer");
      expect(lower.includes("non-optional") || lower.includes("not optional")).toBe(true);
    });

    it("scope_items_referenced", () => {
      expect(interviewText).toContain("ip_risk_scope_items");
    });

    it("minimum_protection_checklist_named", () => {
      const lower = interviewText.toLowerCase();
      expect(lower).toContain("disclaimer");
      expect(lower).toContain("api");
      expect(lower).toContain("asset");
      expect(lower).toContain("hosting");
    });
  });

  describe("TestResearchStrategyIPRisk", () => {
    it("iprisk_narrative_section_present", () => {
      expect(researchText).toContain("IPRisk");
    });

    it("references_ip_risk_doc", () => {
      expect(researchText).toContain("references/ip-risk.md");
    });

    it("references_detect_ip_terms", () => {
      expect(researchText).toContain("detect_ip_terms");
    });

    it("monetization_intent_question_called_out", () => {
      const lower = researchText.toLowerCase();
      expect(lower.includes("monetization-intent") || lower.includes("monetization intent")).toBe(
        true,
      );
    });

    it("lawyer_consultation_non_optional_for_commercial", () => {
      const lower = researchText.toLowerCase();
      expect(lower).toContain("lawyer");
      expect(lower.includes("non-optional") || lower.includes("not optional")).toBe(true);
    });
  });

  describe("TestIPRiskReferenceDoc", () => {
    it("file_exists", () => {
      expect(repoFileExists("references/ip-risk.md")).toBe(true);
    });

    it("has_heuristic_section", () => {
      expect(
        ipRiskText.includes("Heuristic") || ipRiskText.toLowerCase().includes("heuristic"),
      ).toBe(true);
    });

    it("has_question_script_section", () => {
      expect(
        ipRiskText.includes("Question Script") ||
          ipRiskText.toLowerCase().includes("question script"),
      ).toBe(true);
    });

    it("has_minimum_protection_checklist_section", () => {
      expect(
        ipRiskText.includes("Minimum-Protection") ||
          ipRiskText.toLowerCase().includes("minimum-protection"),
      ).toBe(true);
    });

    it("lists_three_protection_items", () => {
      const lower = ipRiskText.toLowerCase();
      expect(lower).toContain("disclaimer");
      expect(lower.includes("api-only") || (lower.includes("api") && lower.includes("asset"))).toBe(
        true,
      );
      expect(lower).toContain("hosting");
    });

    it("references_canonical_helpers", () => {
      expect(ipRiskText).toContain("detect_ip_terms");
      expect(ipRiskText).toContain("ip_risk_scope_items");
      expect(ipRiskText).toContain("plain_risk_summary");
    });

    it("explicitly_disclaims_legal_advice", () => {
      const lower = ipRiskText.toLowerCase();
      expect(lower.includes("not legal advice") || lower.includes("not a law firm")).toBe(true);
    });
  });
});
