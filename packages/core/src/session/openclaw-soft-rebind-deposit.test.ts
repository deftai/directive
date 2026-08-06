import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatOpenClawSoftRebindSkillMarkdown,
  isManagedOpenClawSoftRebindSkill,
  OPENCLAW_SOFT_REBIND_SKILL_ID,
  SOFT_AGENTS_REBIND_MARKER,
} from "./compact-ritual.js";
import {
  assessOpenClawSoftRebindSkill,
  depositOpenClawSoftRebindSkill,
} from "./openclaw-soft-rebind-deposit.js";

describe("depositOpenClawSoftRebindSkill (#3171)", () => {
  it("skips when OpenClaw is not detected", () => {
    const result = depositOpenClawSoftRebindSkill({
      env: {},
      homeDir: join(tmpdir(), "no-oc-soft-deposit-home"),
      forceDeposit: false,
    });
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("openclaw-not-detected");
  });

  it("writes a managed skill from the shared checklist SoT", () => {
    const root = mkdtempSync(join(tmpdir(), "oc-soft-deposit-"));
    const skillsDir = join(root, "skills");
    mkdirSync(skillsDir, { recursive: true });

    const result = depositOpenClawSoftRebindSkill({
      forceDeposit: true,
      skillsDirs: [skillsDir],
    });
    expect(result.changed).toBe(true);
    expect(result.present).toBe(true);

    const path = join(skillsDir, OPENCLAW_SOFT_REBIND_SKILL_ID, "SKILL.md");
    const body = readFileSync(path, "utf8");
    expect(isManagedOpenClawSoftRebindSkill(body)).toBe(true);
    expect(body).toContain(SOFT_AGENTS_REBIND_MARKER);
    expect(body).toBe(formatOpenClawSoftRebindSkillMarkdown());

    const assessment = assessOpenClawSoftRebindSkill(skillsDir);
    expect(assessment.present).toBe(true);
    expect(assessment.custom).toBe(false);

    const second = depositOpenClawSoftRebindSkill({
      forceDeposit: true,
      skillsDirs: [skillsDir],
    });
    expect(second.changed).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });

  it("preserves consumer custom skills at the same slug", () => {
    const root = mkdtempSync(join(tmpdir(), "oc-soft-custom-"));
    const skillsDir = join(root, "skills");
    const skillDir = join(skillsDir, OPENCLAW_SOFT_REBIND_SKILL_ID);
    mkdirSync(skillDir, { recursive: true });
    const custom = "---\nname: custom\n---\n# Consumer custom soft rebind\n";
    writeFileSync(join(skillDir, "SKILL.md"), custom, "utf8");

    const result = depositOpenClawSoftRebindSkill({
      forceDeposit: true,
      skillsDirs: [skillsDir],
    });
    expect(result.changed).toBe(false);
    expect(result.preservedCustomPaths.length).toBe(1);
    expect(readFileSync(join(skillDir, "SKILL.md"), "utf8")).toBe(custom);

    rmSync(root, { recursive: true, force: true });
  });
});
