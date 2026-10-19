import { describe, expect, it } from "vitest";
import { readAgentsMd, readAgentsPreamble, readRepoFile } from "./helpers.js";

/** Port of tests/content/test_agents_md_current_shape.py (#1838 #1530).
 *  Full AGENTS.md "## Umbrella current-shape convention (#1152)" relocated:
 *  agents-entry keeps a pointer; operative reading rules live in preamble § 5.6;
 *  canonical body structure remains in the analysis doc.
 */

const agentsEntryText = readAgentsMd();
const preambleText = readAgentsPreamble();
const analysisText = readRepoFile("docs/analysis/2026-07-02-agents-md-incident-rule-rationale.md");
const ghSliceText = readRepoFile("skills/deft-directive-gh-slice/SKILL.md");
const refinementText = readRepoFile("skills/deft-directive-refinement/SKILL.md");

const CANONICAL_BODY_FIELDS = [
  "Last updated:",
  "Last pass type:",
  "Child count:",
  "Child-count history:",
  "### Open children",
  "### Closed children",
  "### Wave order",
  "### Open questions",
  "### Reading order for fresh contributors",
];

describe("test_agents_md_current_shape", () => {
  it("umbrella_status_pointer_present_in_agents_entry", () => {
    expect(/^##\s+Umbrella status reading\s+\(#1152 \/ #2066\)\s*$/m.test(agentsEntryText)).toBe(
      true,
    );
    expect(agentsEntryText).toContain("Current shape (as of pass-N)");
    expect(agentsEntryText).toContain("deft umbrella:current-shape");
    expect(agentsEntryText).toContain("agent-prompt-preamble.md");
  });

  it("preamble_carries_umbrella_current_shape_reading_rules", () => {
    // Former full RFC2119 AGENTS.md convention body retired; tip teaching is preamble § 5.6.
    expect(preambleText).toContain("## Current shape (as of pass-N)");
    expect(preambleText).toContain("umbrella:current-shape");
    expect(preambleText).toContain("#1152");
    expect(preambleText).toContain("#2066");
  });

  it("agents_entry_forbids_body_alone_umbrella_status", () => {
    expect(agentsEntryText).toContain(
      "Conclude umbrella or epic status from the issue body alone",
    );
  });

  it.each(CANONICAL_BODY_FIELDS)("canonical_body_structure_field_present %s", (field) => {
    expect(analysisText).toContain(field);
  });

  it("body_structure_pass_type_enumerates_all_four", () => {
    for (const passType of ["additive", "subtractive", "refactor", "verify"]) {
      expect(analysisText).toContain(passType);
    }
  });

  it("section_cross_references_consuming_skills", () => {
    expect(analysisText).toContain("deft-directive-gh-slice/SKILL.md");
    expect(analysisText).toContain("deft-directive-refinement/SKILL.md");
    expect(analysisText).toContain("#1140");
    expect(analysisText).toContain("#1119");
  });

  it("gh_slice_skill_cross_references_convention", () => {
    expect(ghSliceText).toContain("Umbrella current-shape convention");
    expect(ghSliceText).toContain("#1152");
  });

  it("refinement_skill_cross_references_convention", () => {
    expect(refinementText).toContain("Umbrella current-shape convention");
    expect(refinementText).toContain("#1152");
  });
});
