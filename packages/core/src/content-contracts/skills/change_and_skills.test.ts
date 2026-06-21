import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers.js";

/** Port of tests/content/test_change_and_skills.py (#1838) */

describe("test_change_and_skills", () => {
  it("commands_md_references_proposal_vbrief_json", () => {
    expect(readRepoFile("commands.md")).toContain("proposal.vbrief.json");
  });

  it("commands_md_no_proposal_md_as_output_artifact", () => {
    const lines = readRepoFile("commands.md").split("\n");
    let inArtifacts = false;
    for (const line of lines) {
      if (line.includes("### Artifacts")) {
        inArtifacts = true;
      } else if (line.startsWith("### ") && inArtifacts) {
        break;
      }
      if (inArtifacts && line.includes("proposal.md") && !line.includes("proposal.vbrief.json")) {
        throw new Error("commands.md: Artifacts section still references proposal.md as output");
      }
    }
  });

  it("commands_md_no_design_md_as_output_artifact", () => {
    const lines = readRepoFile("commands.md").split("\n");
    let inArtifacts = false;
    for (const line of lines) {
      if (line.includes("### Artifacts")) {
        inArtifacts = true;
      } else if (line.startsWith("### ") && inArtifacts) {
        break;
      }
      if (inArtifacts && line.includes("design.md")) {
        throw new Error("commands.md: Artifacts section still references design.md as output");
      }
    }
  });

  it("commands_md_references_delta_vbrief_json", () => {
    expect(readRepoFile("commands.md")).toContain("delta.vbrief.json");
  });

  it("commands_md_no_spec_md_in_specs_section", () => {
    const lines = readRepoFile("commands.md").split("\n");
    let inSpecs = false;
    for (const line of lines) {
      if (line.trim() === "### specs/") {
        inSpecs = true;
      } else if (line.startsWith("### ") && inSpecs) {
        break;
      }
      if (inSpecs && line.includes("spec.md") && !line.includes("delta.vbrief.json")) {
        if (line.includes("\u2297")) {
          continue;
        }
        throw new Error("commands.md: specs/ section still references spec.md as active format");
      }
    }
  });

  it("build_skill_references_proposal_vbrief_json", () => {
    expect(readRepoFile("skills/deft-directive-build/SKILL.md")).toContain("proposal.vbrief.json");
  });

  it("interview_skill_no_authoritative_prd", () => {
    for (const line of readRepoFile("skills/deft-directive-interview/SKILL.md").split("\n")) {
      const lowered = line.toLowerCase();
      if (lowered.includes("prd.md") && lowered.includes("authoritative")) {
        if (lowered.includes("never") || lowered.includes("not") || line.includes("\u2297")) {
          continue;
        }
        throw new Error(
          `interview skill must not reference PRD.md as authoritative: ${line.trim()}`,
        );
      }
    }
  });

  it("interview_skill_output_targets_vbrief", () => {
    expect(readRepoFile("skills/deft-directive-interview/SKILL.md")).toContain(
      "specification.vbrief.json",
    );
  });

  it("interview_skill_has_selection_confirmation", () => {
    expect(readRepoFile("skills/deft-directive-interview/SKILL.md")).toContain(
      "Deterministic Selection Confirmation",
    );
  });

  it("interview_skill_has_backward_navigation", () => {
    expect(readRepoFile("skills/deft-directive-interview/SKILL.md")).toContain(
      "Backward Navigation",
    );
  });

  it("interview_skill_has_option_zero_escape", () => {
    const text = readRepoFile("skills/deft-directive-interview/SKILL.md");
    expect(
      text.includes("Option 0") ||
        text.includes("option 0") ||
        text.includes("Freeform Conversation Escape"),
    ).toBe(true);
  });

  it("setup_skill_phase3_vbrief_draft_approval", () => {
    const text = readRepoFile("skills/deft-directive-setup/SKILL.md");
    expect(text).toContain("specification.vbrief.json");
    expect(text.toLowerCase()).toContain("approval");
    expect(text.toLowerCase()).toContain("vbrief");
  });

  it("setup_skill_phase3_no_authoritative_prd", () => {
    const text = readRepoFile("skills/deft-directive-setup/SKILL.md");
    expect(text).toContain("\u2297");
    expect(text).toContain("authoritative PRD.md");
  });

  it("write_skill_references_composer_porting_guide", () => {
    expect(readRepoFile("skills/deft-directive-write-skill/SKILL.md")).toContain(
      "references/composer-skill-porting.md",
    );
  });

  it("write_skill_requires_negative_triggers", () => {
    const text = readRepoFile("skills/deft-directive-write-skill/SKILL.md");
    expect(text).toContain("Do NOT trigger on");
    expect(text.toLowerCase()).toContain("negative trigger");
  });

  it("write_skill_splits_long_content_to_references", () => {
    expect(readRepoFile("skills/deft-directive-write-skill/SKILL.md")).toContain("references/");
  });

  it("write_skill_requires_body_file_for_github", () => {
    const text = readRepoFile("skills/deft-directive-write-skill/SKILL.md");
    expect(text).toContain("--body-file");
    expect(text).toContain("scm/github.md");
  });
});
