import { describe, expect, it } from "vitest";
import { readRepoFile, readSwarmSkillSurface, repoFileExists } from "./helpers.js";

/** Port of tests/content/test_skills_preflight_call.py (#1838 #810) */

const BUILD_SKILL = "skills/deft-directive-build/SKILL.md";
const SWARM_SKILL = "skills/deft-directive-swarm/SKILL.md";

const PREFLIGHT_HELPER_RE = /!.*task\s+xbrief:preflight/;
const ACTIVATE_TASK_RE = /task\s+xbrief:activate/;

function readSkillSurface(skillPath: string): string {
  if (skillPath === SWARM_SKILL) {
    // #2928: preflight/activate rules live in core-phase-0 reference depth
    return readSwarmSkillSurface();
  }
  return readRepoFile(skillPath);
}

describe("test_skills_preflight_call", () => {
  it.each([
    [BUILD_SKILL, "deft-directive-build"],
    [SWARM_SKILL, "deft-directive-swarm"],
  ])("skill_references_preflight_helper_with_must_marker %s", (skillPath) => {
    expect(repoFileExists(skillPath)).toBe(true);
    const matches = readSkillSurface(skillPath)
      .split("\n")
      .filter((line) => PREFLIGHT_HELPER_RE.test(line));
    expect(matches.length).toBeGreaterThan(0);
  });

  it.each([
    [BUILD_SKILL, "deft-directive-build"],
    [SWARM_SKILL, "deft-directive-swarm"],
  ])("skill_references_activate_task %s", (skillPath) => {
    expect(repoFileExists(skillPath)).toBe(true);
    expect(ACTIVATE_TASK_RE.test(readSkillSurface(skillPath))).toBe(true);
  });
});
