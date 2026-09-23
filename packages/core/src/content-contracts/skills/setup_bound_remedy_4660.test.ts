/**
 * Bound-remedy pins for setup Phase 1/2/3 and read-only session start (#4660).
 */
import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers.js";

const SETUP_SKILL = "skills/deft-directive-setup/SKILL.md";

function packedSetupBody(): string {
  const pack = JSON.parse(readRepoFile("packs/skills/skills-pack-0.1.json")) as {
    skills: Array<{ id: string; body: string }>;
  };
  const setup = pack.skills.find((skill) => skill.id === "deft-directive-setup");
  if (setup === undefined) throw new Error("deft-directive-setup pack entry missing");
  return setup.body;
}

function section(text: string, startHeading: string, endHeading: string): string {
  const start = text.indexOf(startHeading);
  const end = text.indexOf(endHeading);
  expect(start, startHeading).toBeGreaterThanOrEqual(0);
  expect(end, endHeading).toBeGreaterThan(start);
  return text.slice(start, end);
}

function outputPath(phaseText: string): string {
  const start = phaseText.indexOf("### Output Path");
  const template = phaseText.indexOf("### Template");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(template).toBeGreaterThan(start);
  return phaseText.slice(start, template);
}

describe("setup bound remedy (#4660)", () => {
  const rendered = readRepoFile(SETUP_SKILL);
  const packed = packedSetupBody();

  for (const [surface, text] of [
    ["packed", packed],
    ["rendered", rendered],
  ] as const) {
    it(`${surface} Phase 1 remains the preferences-file write`, () => {
      const phase1 = section(text, "## Phase 1", "## Revisit experimental rules");
      expect(phase1).toContain("User Preferences (USER.md)");
      const output = outputPath(phase1);
      expect(output).toContain("Write to the platform-appropriate path");
      expect(output).toContain("$DEFT_USER_PATH");
      expect(output).not.toContain("PROJECT-DEFINITION");
      expect(output).not.toContain("project:write-narratives");
      const template = phase1.slice(phase1.indexOf("### Template"));
      expect(template).toContain("# User Preferences");
      expect(template).not.toContain('"xBRIEFInfo"');
      expect(template).not.toContain("xbrief/PROJECT-DEFINITION.xbrief.json");
    });

    it(`${surface} project identity stays the Phase 2 writer on issue 4663`, () => {
      const phase2 = section(text, "## Phase 2", "## Phase 3");
      expect(phase2).toContain("deft project:write-narratives");
      expect(phase2).toContain(
        "Overview, TechStack, Strategy, Quality, ProjectRules, and Branching",
      );
      expect(phase2).toContain("while `xbrief/active/` is empty");
      expect(phase2).toContain("It is not an agent patch of that file");
      expect(phase2).toContain("It does not set policy keys");
      expect(phase2).toContain(
        "Do not write this document onto `xbrief/PROJECT-DEFINITION.xbrief.json` yourself",
      );
    });

    it(`${surface} proposed work brief stays Phase 3 and waits on the identity write`, () => {
      const phase1 = text.indexOf("## Phase 1");
      const phase2 = text.indexOf("## Phase 2");
      const phase3 = text.indexOf("## Phase 3");
      expect(phase1).toBeGreaterThanOrEqual(0);
      expect(phase2).toBeGreaterThan(phase1);
      expect(phase3).toBeGreaterThan(phase2);
      const phase3Text = section(text, "## Phase 3", "## Warp Auto-Approve Warning");
      expect(phase3Text).toContain("xbrief/proposed/");
      expect(phase3Text).toContain("./xbrief/PROJECT-DEFINITION.xbrief.json");
      expect(phase3Text).toContain("the file written in Phase 2");
      expect(phase3Text).toContain("## Phase 3 — Specification");
    });
  }
});
