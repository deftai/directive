import { describe, expect, it } from "vitest";
import { readRepoFile, repoFileExists } from "./helpers.js";

/** Port of tests/content/test_skills_preflight_call.py (#1838 #810) */

const BUILD_SKILL = "skills/deft-directive-build/SKILL.md";
const SWARM_SKILL = "skills/deft-directive-swarm/SKILL.md";

const PREFLIGHT_HELPER_RE = /!.*task\s+vbrief:preflight/;
const ACTIVATE_TASK_RE = /task\s+vbrief:activate/;

describe("test_skills_preflight_call", () => {
  it.each([
    [BUILD_SKILL, "deft-directive-build"],
    [SWARM_SKILL, "deft-directive-swarm"],
  ])("skill_references_preflight_helper_with_must_marker %s", (skillPath) => {
    expect(repoFileExists(skillPath)).toBe(true);
    const matches = readRepoFile(skillPath)
      .split("\n")
      .filter((line) => PREFLIGHT_HELPER_RE.test(line));
    expect(matches.length).toBeGreaterThan(0);
  });

  it.each([
    [BUILD_SKILL, "deft-directive-build"],
    [SWARM_SKILL, "deft-directive-swarm"],
  ])("skill_references_activate_task %s", (skillPath) => {
    expect(repoFileExists(skillPath)).toBe(true);
    expect(ACTIVATE_TASK_RE.test(readRepoFile(skillPath))).toBe(true);
  });
});
