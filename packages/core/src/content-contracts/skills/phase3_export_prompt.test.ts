import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers.js";

/** Port of tests/content/test_phase3_export_prompt.py (#1838 #433) */

const speckitText = readRepoFile("strategies/speckit.md");
const setupText = readRepoFile("skills/deft-directive-setup/SKILL.md");

describe("test_phase3_export_prompt", () => {
  describe("TestSpeckitArtifactsSummary3c", () => {
    it("artifacts_summary_has_3b_spec_render", () => {
      // Historical marker — 3b row intentionally removed (#1166 s5).
    });

    it("artifacts_summary_has_3c_prd_render", () => {
      expect(speckitText).toContain("3c. Render PRD");
    });

    it("3c_references_task_prd_render", () => {
      expect(speckitText).toContain("task prd:render");
    });
  });

  describe("TestSetupSkillExportPrompt", () => {
    it("prompt_asks_for_prd_or_specification", () => {
      expect(/Generate `SPECIFICATION\.md` and\/or `PRD\.md`/.test(setupText)).toBe(true);
    });

    it("prompt_offers_four_numbered_choices", () => {
      expect(setupText).toContain("`SPECIFICATION.md` only");
      expect(setupText).toContain("`PRD.md` only");
    });

    it("prompt_recommends_stakeholder_review", () => {
      expect(setupText).toContain("stakeholder review");
    });

    it("prompt_runs_before_handoff_to_build", () => {
      const promptIdx = setupText.indexOf("End-of-Phase-3 Export Prompt");
      const handoffIdx = setupText.indexOf("Handoff to deft-directive-build");
      expect(promptIdx).not.toBe(-1);
      expect(handoffIdx).not.toBe(-1);
      expect(promptIdx).toBeLessThan(handoffIdx);
    });
  });
});
