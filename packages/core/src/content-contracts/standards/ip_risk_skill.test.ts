import { describe, expect, it } from "vitest";
import { isFile, readText } from "./_helpers.js";

const interviewText = readText("skills/deft-directive-interview/SKILL.md");
const researchText = readText("strategies/research.md");
const ipRiskText = readText("references/ip-risk.md");

describe("test_ip_risk_skill.py", () => {
  describe("TestInterviewSkillIPRisk", () => {
    it("test_ip_risk_probe_section_present", () => {
      expect(
        interviewText.includes("IP Risk Probe") ||
          interviewText.toLowerCase().includes("ip risk probe"),
      ).toBe(true);
    });
    it("test_references_ip_risk_doc", () => {
      expect(interviewText).toContain("references/ip-risk.md");
    });
    it("test_references_detect_ip_terms", () => {
      expect(interviewText).toContain("detect_ip_terms");
    });
    it("test_monetization_intent_question_called_out", () => {
      const lower = interviewText.toLowerCase();
      expect(lower.includes("monetization-intent") || lower.includes("monetization intent")).toBe(
        true,
      );
    });
    it("test_personal_vs_commercial_branching", () => {
      const lower = interviewText.toLowerCase();
      expect(lower).toContain("personal");
      expect(lower).toContain("commercial");
    });
    it("test_lawyer_consultation_non_optional", () => {
      const lower = interviewText.toLowerCase();
      expect(lower).toContain("lawyer");
      expect(lower.includes("non-optional") || lower.includes("not optional")).toBe(true);
    });
    it("test_scope_items_referenced", () => {
      expect(interviewText).toContain("ip_risk_scope_items");
    });
    it("test_minimum_protection_checklist_named", () => {
      const lower = interviewText.toLowerCase();
      expect(lower).toContain("disclaimer");
      expect(lower).toContain("api");
      expect(lower).toContain("asset");
      expect(lower).toContain("hosting");
    });
  });
  describe("TestResearchStrategyIPRisk", () => {
    it("test_iprisk_narrative_section_present", () => {
      expect(researchText).toContain("IPRisk");
    });
    it("test_references_ip_risk_doc", () => {
      expect(researchText).toContain("references/ip-risk.md");
    });
    it("test_references_detect_ip_terms", () => {
      expect(researchText).toContain("detect_ip_terms");
    });
    it("test_monetization_intent_question_called_out", () => {
      const lower = researchText.toLowerCase();
      expect(lower.includes("monetization-intent") || lower.includes("monetization intent")).toBe(
        true,
      );
    });
    it("test_lawyer_consultation_non_optional_for_commercial", () => {
      const lower = researchText.toLowerCase();
      expect(lower).toContain("lawyer");
      expect(lower.includes("non-optional") || lower.includes("not optional")).toBe(true);
    });
  });
  describe("TestIPRiskReferenceDoc", () => {
    it("test_file_exists", () => {
      expect(isFile("references/ip-risk.md")).toBe(true);
    });
    it("test_has_heuristic_section", () => {
      expect(
        ipRiskText.includes("Heuristic") || ipRiskText.toLowerCase().includes("heuristic"),
      ).toBe(true);
    });
    it("test_has_question_script_section", () => {
      expect(
        ipRiskText.includes("Question Script") ||
          ipRiskText.toLowerCase().includes("question script"),
      ).toBe(true);
    });
    it("test_has_minimum_protection_checklist_section", () => {
      expect(
        ipRiskText.includes("Minimum-Protection") ||
          ipRiskText.toLowerCase().includes("minimum-protection"),
      ).toBe(true);
    });
    it("test_lists_three_protection_items", () => {
      const lower = ipRiskText.toLowerCase();
      expect(lower).toContain("disclaimer");
      expect(lower.includes("api-only") || (lower.includes("api") && lower.includes("asset"))).toBe(
        true,
      );
      expect(lower).toContain("hosting");
    });
    it("test_references_canonical_helpers", () => {
      expect(ipRiskText).toContain("detect_ip_terms");
      expect(ipRiskText).toContain("ip_risk_scope_items");
      expect(ipRiskText).toContain("plain_risk_summary");
    });
    it("test_explicitly_disclaims_legal_advice", () => {
      const lower = ipRiskText.toLowerCase();
      expect(lower.includes("not legal advice") || lower.includes("not a law firm")).toBe(true);
    });
  });
});
