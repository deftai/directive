import { describe, expect, it } from "vitest";
import { readText } from "./_helpers.js";

describe("test_strategy_outputs.py", () => {
  describe("TestRapidVbriefOutput", () => {
    const text = readText("strategies/rapid.md");
    it("test_v020_note_and_contract_citation", () => {
      expect(text).toContain("v0.20 note (s5-migrate-speckit-rapid-enterprise / #1166)");
      expect(text).toContain("strategies/v0-20-contract.md");
    });
    it("test_references_proposed_date_prefixed_vbrief", () => {
      expect(text).toContain("vbrief/proposed/YYYY-MM-DD-");
    });
    it("test_references_project_definition_and_task_project_render", () => {
      expect(text).toContain("vbrief/PROJECT-DEFINITION.vbrief.json");
      expect(text).toContain("task project:render");
    });
    it("test_no_legacy_specification_vbrief", () => {
      const anti = text.includes("## Anti-Patterns")
        ? (text.split("## Anti-Patterns")[1] ?? "")
        : "";
      const pre = text.includes("## Anti-Patterns")
        ? (text.split("## Anti-Patterns")[0] ?? text)
        : text;
      expect(pre).not.toContain("vbrief/specification.vbrief.json");
      expect(
        anti.includes("specification artifact") ||
          anti.toLowerCase().includes("legacy") ||
          anti.includes("v0.20 contract"),
      ).toBe(true);
    });
    it("test_v020_output_shape_section_and_artifacts", () => {
      expect(text).toContain("## v0.20 Output Shape (s5-migrate-speckit-rapid-enterprise / #1166)");
      expect(text).toContain("## Artifacts Summary (v0.20)");
      expect(text).toContain("proposed/YYYY-MM-DD-*.vbrief.json");
      expect(
        text.toLowerCase().includes("deprecation-redirect") ||
          text.toLowerCase().includes("deprecated-redirect"),
      ).toBe(true);
    });
    it("test_follows_artifact_guards_and_gates", () => {
      expect(text).toContain("artifact-guards.md");
      expect(text.includes("Preparatory Guard") || text.includes("Spec-Generating Guard")).toBe(
        true,
      );
    });
    it("test_step1_writes_to_proposed_vbrief_not_spec", () => {
      const step1 = text.split("### Step 1:")[1]?.split("### Step 2:")[0] ?? "";
      expect(step1).toContain("vbrief/proposed/YYYY-MM-DD-");
      expect(step1).not.toContain("specification.vbrief.json");
    });
  });

  describe("TestBddVbriefOutput", () => {
    const text = readText("strategies/bdd.md");
    it("test_references_vbrief_proposed", () => {
      expect(text).toContain("vbrief/proposed/");
    });
    it("test_no_specs_folder_as_output", () => {
      const outputSection = text.split("## Output Artifacts")[1]?.split("##")[0] ?? "";
      expect(outputSection).not.toContain("specs/");
    });
    it("test_contains_locked_decisions_narrative", () => {
      expect(text).toContain("LockedDecisions");
    });
    it("test_no_bdd_context_md_as_primary_output", () => {
      const outputSection = text.split("## Output Artifacts")[1]?.split("##")[0] ?? "";
      expect(outputSection).not.toContain("bdd-context.md");
    });
    it("test_scenarios_narrative", () => {
      expect(text).toContain("Scenarios");
    });
  });

  describe("TestDiscussVbriefOutput", () => {
    const text = readText("strategies/discuss.md");
    it("test_references_vbrief_proposed", () => {
      expect(text).toContain("vbrief/proposed/");
    });
    it("test_no_legacy_context_md_as_primary_output", () => {
      const outputSection = text.split("## Output")[1]?.split("##")[0] ?? "";
      expect(outputSection.replace(/context\.vbrief\.json/g, "")).not.toContain("context.md");
    });
    it("test_locked_decisions_narrative", () => {
      expect(text).toContain("LockedDecisions");
    });
    it("test_vbrief_persist_is_must", () => {
      let found = false;
      for (const line of text.split("\n")) {
        if (line.includes("Persist decisions as vBRIEF narratives")) {
          expect(line.trim().startsWith("- !")).toBe(true);
          found = true;
          break;
        }
      }
      expect(found).toBe(true);
    });
  });

  describe("TestInterviewV020Output", () => {
    const text = readText("strategies/interview.md");
    it("test_references_date_prefixed_proposed_vbrief", () => {
      expect(
        text.includes("YYYY-MM-DD-<slug>.vbrief.json") ||
          text.includes("vbrief/proposed/YYYY-MM-DD"),
      ).toBe(true);
      expect(
        text.toLowerCase().includes("date-prefixed") || text.toLowerCase().includes("date prefix"),
      ).toBe(true);
    });
    it("test_references_task_project_render", () => {
      expect(text).toContain("task project:render");
    });
    it("test_references_project_definition_vbrief", () => {
      expect(text).toContain("PROJECT-DEFINITION.vbrief.json");
    });
    it("test_no_primary_write_of_specification_vbrief", () => {
      expect(text).not.toContain("Write `./vbrief/specification.vbrief.json`");
      expect(text).toContain("Write scope vBRIEF");
    });
    it("test_artifacts_table_mentions_v0_20_and_legacy", () => {
      expect(text.includes("v0.20 contract") || text.includes("Legacy artifact")).toBe(true);
    });
  });
});
