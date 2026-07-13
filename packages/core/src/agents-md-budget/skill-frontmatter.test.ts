import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DAILY_CORE_SKILL_NAMES,
  extractSkillDescription,
  formatCursorAgentSkill,
  measureSkillFrontmatter,
} from "./skill-frontmatter.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function makeSkillsRepo(skills: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "deft-skill-frontmatter-"));
  temps.push(root);
  for (const [name, body] of Object.entries(skills)) {
    const dir = join(root, "content", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), body, "utf8");
  }
  return root;
}

describe("extractSkillDescription", () => {
  it("parses folded YAML descriptions", () => {
    const text = `---
name: demo
description: >-
  Line one
  line two.
---
# body`;
    expect(extractSkillDescription(text)).toBe("Line one\nline two.");
  });

  it("parses single-line descriptions", () => {
    const text = `---
name: demo
description: Short skill blurb.
---
# body`;
    expect(extractSkillDescription(text)).toBe("Short skill blurb.");
  });
});

describe("formatCursorAgentSkill", () => {
  it("uses repo-relative POSIX paths", () => {
    expect(formatCursorAgentSkill("content/skills/foo/SKILL.md", "Do foo.")).toBe(
      '<agent_skill fullPath="content/skills/foo/SKILL.md">Do foo.</agent_skill>',
    );
  });
});

describe("measureSkillFrontmatter", () => {
  const setupSkill = `---
name: deft-directive-setup
description: Setup project.
---
# Setup`;

  const syncSkill = `---
name: deft-directive-sync
description: Sync framework.
---
# Sync`;

  const releaseSkill = `---
name: deft-directive-release
description: Release workflows.
---
# Release`;

  it("returns zero bytes when harness profile is none", () => {
    const root = makeSkillsRepo({
      "deft-directive-setup": setupSkill,
    });
    const result = measureSkillFrontmatter(root, { harnessProfile: "none" });
    expect(result.bytes).toBe(0);
    expect(result.skillCount).toBe(0);
  });

  it("measures all skills for cursor/all tier", () => {
    const root = makeSkillsRepo({
      "deft-directive-setup": setupSkill,
      "deft-directive-release": releaseSkill,
    });
    const result = measureSkillFrontmatter(root, { harnessProfile: "cursor", tier: "all" });
    expect(result.skillCount).toBe(2);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.entries).toHaveLength(2);
  });

  it("filters to daily-core tier only", () => {
    const root = makeSkillsRepo({
      "deft-directive-setup": setupSkill,
      "deft-directive-sync": syncSkill,
      "deft-directive-release": releaseSkill,
    });
    const all = measureSkillFrontmatter(root, { harnessProfile: "cursor", tier: "all" });
    const daily = measureSkillFrontmatter(root, { harnessProfile: "cursor", tier: "daily-core" });
    expect(daily.skillCount).toBe(2);
    expect(daily.bytes).toBeLessThan(all.bytes);
    expect(daily.entries.every((e) => DAILY_CORE_SKILL_NAMES.includes(e.skillName as never))).toBe(
      true,
    );
  });
});
