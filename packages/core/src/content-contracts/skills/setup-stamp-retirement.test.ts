import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers.js";
import {
  assertSetupRetirementLocks,
  findRetiredStampRestoreInstructions,
  markdownListAndSectionUnits,
  PACK_TO_SKILL_REGEN,
  PACKS_RENDER_SKILLS_OUT_OF_SCOPE,
  PROJECTION_CONTROL,
  SPECIFICATION_DEFT_VERSION_SEEDING,
  unitInstructsXbriefStampRestore,
} from "./setup-stamp-retirement.js";

const SETUP_SKILL = "skills/deft-directive-setup/SKILL.md";

function packedSetupBody(): string {
  const pack = JSON.parse(readRepoFile("packs/skills/skills-pack-0.1.json")) as {
    skills: Array<{
      id: string;
      body: string;
      description?: string;
      frontmatter_extra?: string | null;
    }>;
  };
  const setup = pack.skills.find((skill) => skill.id === "deft-directive-setup");
  if (setup === undefined) throw new Error("deft-directive-setup pack entry missing");
  return setup.body;
}

function packedSetupFullSurface(): string {
  const pack = JSON.parse(readRepoFile("packs/skills/skills-pack-0.1.json")) as {
    skills: Array<{
      id: string;
      body: string;
      description?: string;
      frontmatter_extra?: string | null;
    }>;
  };
  const setup = pack.skills.find((skill) => skill.id === "deft-directive-setup");
  if (setup === undefined) throw new Error("deft-directive-setup pack entry missing");
  return [setup.description ?? "", setup.frontmatter_extra ?? "", setup.body].join("\n");
}

describe("setup stamp retirement locks (#4271)", () => {
  it("treats a wrapped deft_version + PROJECT-DEFINITION list item as one unit", () => {
    const wrapped = [
      "- When generating",
      "  PROJECT-DEFINITION.xbrief.json, set",
      "  deft_version",
    ].join("\n");
    const units = markdownListAndSectionUnits(wrapped);
    expect(units).toHaveLength(1);
    expect(unitInstructsXbriefStampRestore(units[0] ?? "")).toBe(true);
    const lineHits = wrapped
      .split("\n")
      .filter((line) => /deft_version/.test(line) && /PROJECT-DEFINITION/.test(line));
    expect(lineHits).toHaveLength(0);
  });
  it("allows USER.md-only deft_version rules", () => {
    const unit = "- ! When generating USER.md, the deft_version field MUST be set";
    expect(unitInstructsXbriefStampRestore(unit)).toBe(false);
  });

  it("does not exempt a User Preferences section that also names PROJECT-DEFINITION", () => {
    const markdown = [
      "# User Preferences",
      "",
      "When generating PROJECT-DEFINITION.xbrief.json, set deft_version",
    ].join("\n");
    const units = markdownListAndSectionUnits(markdown);
    expect(units).toHaveLength(1);
    expect(unitInstructsXbriefStampRestore(units[0] ?? "")).toBe(true);
  });

  it("fails a MUST-set mandate naming PROJECT-DEFINITION and deft_version", () => {
    const unit =
      "- ! When generating USER.md or PROJECT-DEFINITION.xbrief.json, the deft_version field MUST be set";
    expect(unitInstructsXbriefStampRestore(unit)).toBe(true);
  });

  it("allows a forbid anti-pattern that names both tokens", () => {
    const unit = "- ⊗ Write deft_version into PROJECT-DEFINITION.xbrief.json";
    expect(unitInstructsXbriefStampRestore(unit)).toBe(false);
  });
  it("fails a JSON DeftVersion seed", () => {
    const unit = `"DeftVersion": 0.20.0`;
    expect(unitInstructsXbriefStampRestore(unit)).toBe(true);
  });

  it("scans packed body and whole rendered skill including frontmatter", () => {
    const packed = packedSetupBody();
    const rendered = readRepoFile(SETUP_SKILL);
    expect(rendered.startsWith("---")).toBe(true);
    expect(() => assertSetupRetirementLocks(packed)).not.toThrow();
    expect(() => assertSetupRetirementLocks(rendered)).not.toThrow();
    expect(() => assertSetupRetirementLocks(packedSetupFullSurface())).not.toThrow();
    expect(findRetiredStampRestoreInstructions(packed)).toEqual([]);
    expect(findRetiredStampRestoreInstructions(rendered)).toEqual([]);
  });

  it("names packs:render and packs:verify-drift; packs:render-skills is out of scope", () => {
    const rendered = readRepoFile(SETUP_SKILL);
    expect(PACK_TO_SKILL_REGEN).toBe("task packs:render");
    expect(PROJECTION_CONTROL).toBe("task packs:verify-drift");
    expect(PACKS_RENDER_SKILLS_OUT_OF_SCOPE).toBe("task packs:render-skills");
    expect(rendered).toContain(PACK_TO_SKILL_REGEN);
    expect(rendered).not.toContain("task packs:render-skills");
  });

  it("states specification deft_version has no framework seeding path", () => {
    expect(SPECIFICATION_DEFT_VERSION_SEEDING).toBe("none-pass1-absence-lock-only");
  });

  it("assertSetupRetirementLocks names packs:render referents and forbids render-skills", () => {
    expect(() => assertSetupRetirementLocks("task packs:render-skills")).toThrow(
      PACK_TO_SKILL_REGEN,
    );
    expect(() => assertSetupRetirementLocks("task packs:render-skills")).toThrow(
      PROJECTION_CONTROL,
    );
    expect(() =>
      assertSetupRetirementLocks(
        "- When generating PROJECT-DEFINITION.xbrief.json, set deft_version",
      ),
    ).toThrow(SPECIFICATION_DEFT_VERSION_SEEDING);
  });
});
