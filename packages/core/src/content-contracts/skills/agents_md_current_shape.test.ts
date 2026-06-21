import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers.js";

/** Port of tests/content/test_agents_md_current_shape.py (#1838 #1530) */

const agentsMdText = readRepoFile("AGENTS.md");
const ghSliceText = readRepoFile("skills/deft-directive-gh-slice/SKILL.md");
const refinementText = readRepoFile("skills/deft-directive-refinement/SKILL.md");

const REQUIRED_RULE_LINES = [
  "! Every umbrella issue MUST have a single canonical `## Current shape (as of pass-N)` comment, edited in place after each design pass.",
  "! The current-shape comment MUST list open children, closed children, wave order, and the child-count history.",
  "~ Pass-N skills SHOULD update the current-shape comment as their Phase 4 step.",
  "\u2297 Do NOT delete prior amendment comments when updating the current-shape comment \u2014 they remain the audit trail.",
  "\u2297 Do NOT replace the current-shape comment with a fresh comment \u2014 it must be edited in place so its permalink is stable.",
];

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

function extractSection(text: string, headingPattern: string): string {
  const headingRe = new RegExp(`^##\\s+${headingPattern}`, "m");
  const match = headingRe.exec(text);
  if (!match || match.index === undefined) {
    return "";
  }
  const start = match.index;
  const afterHeading = text.slice(start + match[0].length);
  const nextHeading = afterHeading.search(/^##\s/m);
  return nextHeading === -1
    ? text.slice(start)
    : text.slice(start, start + match[0].length + nextHeading);
}

describe("test_agents_md_current_shape", () => {
  it("umbrella_current_shape_section_header_present", () => {
    expect(/^##\s+Umbrella current-shape convention\s+\(#1152\)\s*$/m.test(agentsMdText)).toBe(
      true,
    );
  });

  it.each(REQUIRED_RULE_LINES)("required_rfc2119_rule_lines_present %s", (ruleLine) => {
    const section = extractSection(agentsMdText, "Umbrella current-shape convention \\(#1152\\)");
    expect(section).toBeTruthy();
    expect(section).toContain(ruleLine);
  });

  it("section_uses_canonical_rfc2119_markers", () => {
    const section = extractSection(agentsMdText, "Umbrella current-shape convention \\(#1152\\)");
    expect(/^-\s+!\s+Every umbrella issue MUST/m.test(section)).toBe(true);
    expect(/^-\s+~\s+Pass-N skills SHOULD/m.test(section)).toBe(true);
    const mustNotLines = section.match(/^-\s+\u2297\s+Do NOT/gm) ?? [];
    expect(mustNotLines.length).toBe(2);
  });

  it.each(CANONICAL_BODY_FIELDS)("canonical_body_structure_field_present %s", (field) => {
    const section = extractSection(agentsMdText, "Umbrella current-shape convention \\(#1152\\)");
    expect(section).toContain(field);
  });

  it("body_structure_pass_type_enumerates_all_four", () => {
    const section = extractSection(agentsMdText, "Umbrella current-shape convention \\(#1152\\)");
    for (const passType of ["additive", "subtractive", "refactor", "verify"]) {
      expect(section).toContain(passType);
    }
  });

  it("section_cross_references_consuming_skills", () => {
    const section = extractSection(agentsMdText, "Umbrella current-shape convention \\(#1152\\)");
    expect(section).toContain("skills/deft-directive-gh-slice/SKILL.md");
    expect(section).toContain("skills/deft-directive-refinement/SKILL.md");
    expect(section).toContain("#1140");
    expect(section).toContain("#1119");
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
