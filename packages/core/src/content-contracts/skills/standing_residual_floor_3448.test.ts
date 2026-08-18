import { describe, expect, it } from "vitest";
import { readRepoFile, readSkill, readSwarmSkillSurface } from "./helpers.js";

/**
 * #3448 — Standing residual until resolved conf floor or same-fingerprint loop.
 * Asserts leftover A/B/C, floor-relative continue-until, standing vs one-shot,
 * same-fingerprint halt, #2881 already-touched carve-out, halt-report fields.
 */

const FOLLOWUP_SECTION = "Operator follow-up after dual-stop / hard stop (#3273)";
const OUT_OF_AC = "Out-of-AC findings / active-story scope gate (#2881)";
const STANDING_PHRASES = [
  "until floor or loop",
  "until greptile meets policy",
  "pursue residuals until told otherwise",
] as const;
const ONE_SHOT_PHRASES = [
  "pursue residual",
  "follow-up hard-stop",
  "same as conf-hold",
  "continue dual-stopped PR",
] as const;

function assertAbcAndFloorRelative(text: string): void {
  expect(text).toContain("class A");
  expect(text).toContain("class B");
  expect(text).toContain("class C");
  expect(text).toContain("#3095");
  expect(text).toContain("minGreptileConfidence");
  expect(text).toContain("consumer default");
  expect(text).toMatch(/dogfood/);
  expect(text).toContain("policy:show --field=minGreptileConfidence");
  expect(text).toContain("task policy:show");
  expect(text).toContain("deft policy:show");
  expect(text).toMatch(/\u2297 Hard-code 5\/5/);
  expect(text).not.toMatch(/until 5\/5/);
}

describe("standing_residual_floor_3448", () => {
  it("review_cycle_3273_and_2881_name_leftover_classes_and_floor", () => {
    const skill = readSkill("skills/deft-directive-review-cycle/SKILL.md");
    expect(skill).toContain(FOLLOWUP_SECTION);
    expect(skill).toContain(OUT_OF_AC);
    assertAbcAndFloorRelative(skill);
    expect(skill).toMatch(/already-touched|already in the PR/);
    expect(skill).toContain("in-AC residual");
  });

  it("review_cycle_standing_phrases_distinct_from_oneshot", () => {
    const skill = readSkill("skills/deft-directive-review-cycle/SKILL.md");
    expect(skill).toMatch(/When to Use[\s\S]*until floor or loop/);
    expect(skill).toMatch(/When to Use[\s\S]*pursue residual/);
    for (const phrase of STANDING_PHRASES) {
      expect(skill).toContain(phrase);
    }
    for (const phrase of ONE_SHOT_PHRASES) {
      expect(skill).toContain(phrase);
    }
    expect(skill).toContain("open cohort");
    expect(skill).toContain("one-shot");
    expect(skill).toContain("standing");
  });

  it("review_cycle_same_fingerprint_halt_and_2442_cap", () => {
    const skill = readSkill("skills/deft-directive-review-cycle/SKILL.md");
    expect(skill).toMatch(/same-fingerprint|same primary leftover fingerprint/);
    expect(skill).toContain("#2442");
  });

  it("review_cycle_halt_report_includes_leftover_floor_standing", () => {
    const skill = readSkill("skills/deft-directive-review-cycle/SKILL.md");
    expect(skill).toContain("Halt-report resume line");
    expect(skill).toContain("leftover=");
    expect(skill).toContain("floor=");
    expect(skill).toContain("standing=");
  });

  it("swarm_surface_names_abc_standing_and_floor", () => {
    const text = readSwarmSkillSurface();
    expect(text).toContain(FOLLOWUP_SECTION);
    assertAbcAndFloorRelative(text);
    for (const phrase of STANDING_PHRASES) {
      expect(text).toContain(phrase);
    }
    expect(text).toContain("open cohort");
    expect(text).toMatch(/same-fingerprint|same primary leftover fingerprint/);
    expect(text).toContain("#2442");
    expect(text).toMatch(/already-touched|already in the PR/);
  });

  it("swarm_thin_skill_points_at_standing_and_abc", () => {
    const skill = readSkill("skills/deft-directive-swarm/SKILL.md");
    expect(skill).toContain(FOLLOWUP_SECTION);
    expect(skill).toContain("class A");
    expect(skill).toContain("class B");
    expect(skill).toContain("class C");
    expect(skill).toMatch(/When to Use[\s\S]*until floor or loop/);
    expect(skill).toContain("until floor or loop");
    expect(skill).toContain("leftover=");
    expect(skill).toContain("floor=");
    expect(skill).toContain("standing=");
  });

  it("swarm_phase4_halt_report_and_standing_depth", () => {
    const phase4 = readRepoFile("skills/deft-directive-swarm/references/core-phase-4.md");
    expect(phase4).toContain(FOLLOWUP_SECTION);
    expect(phase4).toContain("RESUME: residual=");
    expect(phase4).toContain("leftover=");
    expect(phase4).toContain("floor=");
    expect(phase4).toContain("standing=");
    for (const phrase of STANDING_PHRASES) {
      expect(phase4).toContain(phrase);
    }
    expect(phase4).toContain("#3095");
    expect(phase4).toMatch(/\u2297 Hard-code 5\/5/);
    expect(phase4).not.toMatch(/until 5\/5/);
    expect(phase4).toMatch(/same-fingerprint|same primary leftover fingerprint/);
  });

  it("swarm_ops_halt_resume_includes_leftover_floor_standing", () => {
    const ops = readRepoFile("skills/deft-directive-swarm/references/core-ops.md");
    expect(ops).toContain("#3448");
    expect(ops).toContain("leftover class");
    expect(ops).toContain("resolved floor");
    expect(ops).toContain("standing vs one-shot");
  });

  it("changelog_and_commands_cite_3448", () => {
    const changelog = readRepoFile("CHANGELOG.md");
    expect(changelog).toContain("#3448");
    expect(changelog).toMatch(/## \[Unreleased\][\s\S]*#3448/);
    const commands = readRepoFile("commands.md");
    expect(commands).toContain("#3448");
    expect(commands).toContain("until floor or loop");
    expect(commands).toContain("pursue residual");
  });
});
