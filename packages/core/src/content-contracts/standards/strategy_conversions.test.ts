import { describe, expect, it } from "vitest";
import { readText } from "./_helpers.js";

describe("test_strategy_conversions.py", () => {
  describe("TestResearchVBRIEF", () => {
    const text = readText("strategies/research.md");
    it("test_references_vbrief_proposed_path", () => {
      expect(text).toContain("vbrief/proposed/");
    });
    it("test_references_dont_hand_roll_narrative", () => {
      expect(text).toContain("DontHandRoll");
    });
    it("test_references_common_pitfalls_narrative", () => {
      expect(text).toContain("CommonPitfalls");
    });
    it("test_no_feature_research_md_output", () => {
      expect(text).not.toContain("Produce `{feature}-research.md`");
    });
    it("test_chaining_gate_references_vbrief", () => {
      expect(text).toContain("vbrief/proposed/{feature}-research.vbrief.json");
    });
  });
  describe("TestMapVBRIEF", () => {
    const text = readText("strategies/map.md");
    it("test_references_vbrief_proposed_path", () => {
      expect(text).toContain("vbrief/proposed/");
    });
    it("test_references_stack_narrative", () => {
      expect(text).toContain("`Stack`");
    });
    it("test_references_architecture_narrative", () => {
      expect(text).toContain("`Architecture`");
    });
    it("test_references_conventions_narrative", () => {
      expect(text).toContain("`Conventions`");
    });
    it("test_references_concerns_narrative", () => {
      expect(text).toContain("`Concerns`");
    });
    it("test_no_planning_codebase_output", () => {
      expect(text).not.toContain(".planning/codebase/");
    });
    it("test_chaining_gate_references_vbrief", () => {
      expect(text).toContain("vbrief/proposed/{project}-codebase-map.vbrief.json");
    });
  });
  describe("TestRoadmapRedirect", () => {
    const text = readText("strategies/roadmap.md");
    it("test_contains_superseded", () => {
      expect(text.toLowerCase()).toContain("superseded");
    });
    it("test_references_refinement_skill", () => {
      expect(text).toContain("deft-directive-refinement");
    });
    it("test_references_roadmap_render", () => {
      expect(text).toContain("roadmap:render");
    });
    it("test_no_workflow_sections", () => {
      expect(text).not.toContain("### Step 1");
    });
  });
});
