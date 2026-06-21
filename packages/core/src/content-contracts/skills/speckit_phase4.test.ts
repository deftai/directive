import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers.js";

/** Port of tests/content/test_speckit_phase4.py (#1838 #436) */

const speckitText = readRepoFile("strategies/speckit.md");
const vbriefMdText = readRepoFile("vbrief/vbrief.md");

describe("test_speckit_phase4", () => {
  describe("TestSpeckitPhase4Emission", () => {
    it("phase_4_heading_updated", () => {
      expect(speckitText).toContain("## Phase 4: Implementation Phase / Epic Scope Emission");
    });

    it("phase_45_heading_present", () => {
      expect(speckitText).toContain("## Phase 4.5: Story Decomposition / Swarm Readiness");
    });

    it("phase_4_writes_to_pending_folder", () => {
      expect(speckitText).toContain("./vbrief/pending/");
    });

    it("phase_4_filename_convention", () => {
      expect(speckitText).toContain("YYYY-MM-DD-ip<NNN>-<slug>.vbrief.json");
    });

    it("phase_4_requires_canonical_narrative_keys", () => {
      for (const key of ["Description", "Acceptance", "Traces"]) {
        expect(speckitText).toContain(`plan.narratives.${key}`);
      }
    });

    it("phase_4_links_back_to_specification", () => {
      expect(speckitText).toContain("x-vbrief/plan");
    });

    it("phase_4_plan_metadata_dependencies", () => {
      expect(speckitText).toContain("plan.metadata.dependencies");
    });

    it("phase_4_marks_kind_phase_or_epic", () => {
      expect(speckitText).toContain('plan.metadata.kind = "phase"');
      expect(speckitText).toContain('"epic"');
    });

    it("phase_45_requires_story_swarm_metadata", () => {
      for (const token of [
        'plan.metadata.kind = "story"',
        "non-empty `plan.items`",
        "plan.metadata.swarm.file_scope",
        "plan.metadata.swarm.verify_commands",
        "planRef",
      ]) {
        expect(speckitText).toContain(token);
      }
    });

    it("phase_4_plan_vbrief_is_session_todo", () => {
      expect(speckitText).toContain("session-todo role");
    });

    it("phase_4_forbids_project_wide_task_list_in_plan_vbrief", () => {
      expect(speckitText).toContain(
        "Emit the project-wide Phase 4 task list to `plan.vbrief.json`",
      );
    });

    it("artifacts_summary_has_3c_render_row", () => {
      expect(speckitText).toContain("3c. Render PRD");
    });

    it("artifacts_summary_points_phase_4_at_proposed_scope_vbriefs_v020", () => {
      expect(speckitText).toContain("`./vbrief/proposed/YYYY-MM-DD-ip<NNN>-<slug>.vbrief.json`");
    });

    it("artifacts_summary_includes_phase_45", () => {
      expect(speckitText).toContain("4.5. Story decomposition");
    });

    it("migrator_flag_documented", () => {
      expect(speckitText).toContain("--speckit-plan");
    });
  });

  describe("TestVbriefMdUpdates", () => {
    it("ip_filename_convention_documented", () => {
      expect(vbriefMdText).toContain("YYYY-MM-DD-ip<NNN>-<slug>.vbrief.json");
    });

    it("ip_padding_is_three_digits", () => {
      expect(
        vbriefMdText.includes("3 digits") || vbriefMdText.toLowerCase().includes("three digits"),
      ).toBe(true);
    });

    it("canonical_narrative_keys_documented", () => {
      for (const key of ["Description", "Acceptance", "Traces"]) {
        expect(vbriefMdText).toContain(key);
      }
    });

    it("plan_metadata_dependencies_documented", () => {
      expect(vbriefMdText).toContain("plan.metadata.dependencies");
    });

    it("plan_level_placement_explicit", () => {
      expect(vbriefMdText.toLowerCase()).toContain("plan-level");
    });
  });
});
