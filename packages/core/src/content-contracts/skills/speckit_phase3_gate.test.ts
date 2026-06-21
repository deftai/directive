import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers.js";

/** Port of tests/content/test_speckit_phase3_gate.py (#1838 #432) */

const speckitText = readRepoFile("strategies/speckit.md");
const setupText = readRepoFile("skills/deft-directive-setup/SKILL.md");

describe("test_speckit_phase3_gate", () => {
  describe("TestSpeckitPhase3TransitionGate", () => {
    it("post_phase_3_is_numbered_transition_gate", () => {
      expect(speckitText).toContain("### Post-Phase 3 Transition Gate");
    });

    it("gate_is_numbered_list_mirroring_phase2_approval", () => {
      expect(
        speckitText.includes("1. ! Run `task spec:render`") ||
          speckitText.includes("task spec:render"),
      ).toBe(true);
      expect(
        speckitText.includes("Confirm any rendered `SPECIFICATION.md`") ||
          speckitText.includes("derivative"),
      ).toBe(true);
    });

    it("transition_criterion_references_specification_md", () => {
      expect(speckitText).toContain("Phase 3 -> Phase 4 transition criterion");
      expect(speckitText).toContain("without review of the v0.20 artifacts");
    });

    it("gate_references_setup_skill_invocation", () => {
      expect(speckitText).toContain("deft-directive-setup/SKILL.md");
    });
  });

  describe("TestSetupSkillPhase3RenderBoundary", () => {
    it("end_of_phase_3_export_prompt_exists", () => {
      expect(setupText).toContain("End-of-Phase-3 Export Prompt");
    });

    it("setup_invokes_task_spec_render_at_boundary", () => {
      expect(setupText).toContain("task spec:render");
    });

    it("setup_prompts_for_prd_and_spec", () => {
      expect(setupText).toContain("Generate `SPECIFICATION.md` and/or `PRD.md` now");
    });

    it("speckit_phase_4_gate_wiring", () => {
      expect(
        setupText.includes("speckit Phase 3 \u2192 Phase 4") ||
          setupText.includes("speckit Phase 3 -> Phase 4"),
      ).toBe(true);
    });
  });
});
