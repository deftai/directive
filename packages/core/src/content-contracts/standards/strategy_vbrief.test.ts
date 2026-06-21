import { describe, expect, it } from "vitest";
import { readText } from "./_helpers.js";

describe("test_strategy_vbrief.py", () => {
  describe("TestSpeckitVbriefOutputs", () => {
    const text = readText("strategies/speckit.md");
    it("test_speckit_references_project_definition_vbrief", () => {
      expect(text).toContain("PROJECT-DEFINITION.vbrief.json");
    });
    it("test_speckit_references_specification_vbrief", () => {
      expect(text).toContain("specification.vbrief.json");
    });
    it("test_speckit_no_specs_output_directory", () => {
      expect(text).not.toContain("specs/[feature]");
      expect(text).not.toContain("specs/{feature}");
    });
    it("test_speckit_references_spec_render", () => {
      expect(text).toContain("task spec:render");
    });
    it("test_speckit_no_standalone_plan_md_input", () => {
      expect(text).not.toContain("Approved `plan.md`");
    });
    it("test_speckit_no_project_md_principles_reference", () => {
      expect(text).not.toContain("project.md Principles");
    });
  });
  describe("TestEnterpriseVbriefOutputs", () => {
    const text = readText("strategies/enterprise.md");
    it("test_enterprise_references_prd_render", () => {
      expect(text).toContain("task prd:render");
    });
    it("test_enterprise_references_spec_render", () => {
      expect(text).toContain("task spec:render");
    });
    it("test_enterprise_references_specification_vbrief", () => {
      expect(text).toContain("specification.vbrief.json");
    });
    it("test_enterprise_preserves_approval_gates", () => {
      expect(text).toContain("Gate 1: PRD Approval");
      expect(text).toContain("Gate 2: ADR Approval");
      expect(text).toContain("Gate 3: Specification Approval");
    });
    it("test_enterprise_adrs_unaffected", () => {
      expect(text).toContain("docs/adr/");
    });
  });
});
