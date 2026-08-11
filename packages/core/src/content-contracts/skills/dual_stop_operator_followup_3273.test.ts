import { describe, expect, it } from "vitest";
import { readRepoFile, readSkill, readSwarmSkillSurface } from "./helpers.js";

/**
 * #3273 — Operator follow-up after dual-stop / hard stop.
 * Asserts named section + halt-report resume markers on swarm + review-cycle surfaces.
 */

const FOLLOWUP_SECTION = "Operator follow-up after dual-stop / hard stop (#3273)";
const HALT_RESUME = "Halt-report resume line";
const RESUME_PHRASES = [
  "pursue residual",
  "follow-up hard-stop",
  "same as conf-hold",
  "continue dual-stopped PR",
] as const;

describe("dual_stop_operator_followup_3273", () => {
  it("swarm_surface_has_named_followup_section", () => {
    const text = readSwarmSkillSurface();
    expect(text).toContain(FOLLOWUP_SECTION);
    expect(text).toContain("#3273");
  });

  it("swarm_thin_skill_points_at_followup_and_triggers", () => {
    const skill = readSkill("skills/deft-directive-swarm/SKILL.md");
    expect(skill).toContain(FOLLOWUP_SECTION);
    expect(skill).toContain(HALT_RESUME);
    for (const phrase of RESUME_PHRASES) {
      expect(skill).toContain(phrase);
    }
    // When to Use routing
    expect(skill).toMatch(/When to Use[\s\S]*pursue residual/);
  });

  it("swarm_phase4_halt_report_resume_affordance", () => {
    const phase4 = readRepoFile("skills/deft-directive-swarm/references/core-phase-4.md");
    expect(phase4).toContain(FOLLOWUP_SECTION);
    expect(phase4).toContain(HALT_RESUME);
    expect(phase4).toContain("RESUME: residual=");
    for (const phrase of RESUME_PHRASES) {
      expect(phase4).toContain(phrase);
    }
    // Anti thrash
    expect(phase4).toMatch(/\u2297 Unlimited auto-retry after dual-stop/);
    expect(phase4).toContain("minGreptileConfidence");
    expect(phase4).toContain("#2843");
    // Low-token existing surfaces
    expect(phase4).toContain("pr:merge-ready");
    expect(phase4).toContain("pr:watch");
  });

  it("swarm_ops_forbids_halt_without_resume_line", () => {
    const ops = readRepoFile("skills/deft-directive-swarm/references/core-ops.md");
    expect(ops).toContain("#3273");
    expect(ops).toMatch(
      /\u2297 Emit a dual-stop \/ hard-stop \/ conf-residual terminal halt report/,
    );
    for (const phrase of RESUME_PHRASES) {
      expect(ops).toContain(phrase);
    }
  });

  it("review_cycle_has_matching_followup_and_halt_resume", () => {
    const skill = readSkill("skills/deft-directive-review-cycle/SKILL.md");
    expect(skill).toContain(FOLLOWUP_SECTION);
    expect(skill).toContain(HALT_RESUME);
    for (const phrase of RESUME_PHRASES) {
      expect(skill).toContain(phrase);
    }
    expect(skill).toMatch(/When to Use[\s\S]*pursue residual/);
    expect(skill).toMatch(/\u2297 Unlimited auto-retry after dual-stop/);
    expect(skill).toContain("this PR only");
    expect(skill).toContain("minGreptileConfidence");
  });

  it("changelog_and_commands_cite_3273", () => {
    // CHANGELOG.md is root-resident; helpers fall back from content/ to root.
    expect(readRepoFile("CHANGELOG.md")).toContain("#3273");
    const commands = readRepoFile("commands.md");
    expect(commands).toContain("#3273");
    expect(commands).toContain("pursue residual");
  });
});
