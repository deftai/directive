/**
 * Prefer-A Bound pins for interview phase/approval durable carrier (#5352).
 * Dual pack+rendered surfaces; content-contract carrier-assert posture (S3).
 */
import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers.js";

const INTERVIEW_SKILL = "skills/deft-directive-interview/SKILL.md";
const SETUP_SKILL = "skills/deft-directive-setup/SKILL.md";
const STRATEGY = "strategies/interview.md";
const CONTINUE = "resilience/continue-here.md";

function packedBody(skillId: string): string {
  const pack = JSON.parse(readRepoFile("packs/skills/skills-pack-0.1.json")) as {
    skills: Array<{ id: string; body: string }>;
  };
  const skill = pack.skills.find((entry) => entry.id === skillId);
  if (skill === undefined) throw new Error(`${skillId} pack entry missing`);
  return skill.body;
}

const REQUIRED_CARRIER_MARKERS = [
  'plan["x-directive/interviewContinuation"]',
  "planning-draft-approved",
  "correction-or-gap-review",
  "artifact-approved",
  "deferred-resume",
  "Content-contract carrier-assert",
  "reopenableDecisionSet",
  "operatorAdoptionMarkers",
  "confirmations[]",
] as const;

describe("interview continuation carrier (#5352 Prefer-A Bound)", () => {
  for (const [surface, text] of [
    ["packed", packedBody("deft-directive-interview")],
    ["rendered", readRepoFile(INTERVIEW_SKILL)],
  ] as const) {
    it(`${surface} interview Rule 12 names durable carrier + closed phase enum`, () => {
      expect(text).toContain("### Rule 12: Durable Interview Continuation (#5352 Prefer-A Bound)");
      for (const marker of REQUIRED_CARRIER_MARKERS) {
        expect(text).toContain(marker);
      }
      expect(text.toLowerCase()).toContain("continue-here");
      expect(text).toContain("answer");
      expect(text).toContain("artifact");
      expect(text).toContain("phase");
      expect(text).toContain("refuse-to-widen");
      expect(text).toContain("demonstrable dependents");
    });

    it(`${surface} interview anti-patterns refuse continue-here as carrier`, () => {
      expect(text).toContain(
        "Use ephemeral continue-here / `xbrief/continue.xbrief.json` as the durable interview phase/approval-scope carrier (#5352)",
      );
      expect(text).toContain(
        "Treat ordinary design-answer numerics (Rule 8) as artifact or build approval (#5352)",
      );
      expect(text).toContain("Widen a post-draft correction delta beyond operator-enumerated keys");
    });
  }

  for (const [surface, text] of [
    ["packed", packedBody("deft-directive-setup")],
    ["rendered", readRepoFile(SETUP_SKILL)],
  ] as const) {
    it(`${surface} setup bind-map points Post-Interview + Full Path at carrier`, () => {
      expect(text).toContain("Interview continuation carrier (#5352 Prefer-A Bound)");
      expect(text).toContain('plan["x-directive/interviewContinuation"]');
      expect(text).toContain("Post-Interview Confirmation Gate");
      expect(text).toContain("Output — Full Path");
      expect(text).toContain("Planning-only wins");
    });
  }

  it("strategies/interview.md documents carrier + planning-only precedence on approve menu", () => {
    const text = readRepoFile(STRATEGY);
    expect(text).toContain("Interview continuation carrier (#5352 Prefer-A Bound)");
    expect(text).toContain('plan["x-directive/interviewContinuation"]');
    expect(text).toContain("Approve and continue (lock the SPEC, proceed to implementation)");
    expect(text).toContain("silently override");
    expect(text).toContain("First-delta initialize");
    expect(text).toContain("Incomplete carrier refuse");
  });

  it("continue-here.md explicitly excludes itself as interview phase/approval carrier", () => {
    const text = readRepoFile(CONTINUE);
    expect(text).toContain("Not the interview phase/approval carrier (#5352 Prefer-A Bound)");
    expect(text).toContain('plan["x-directive/interviewContinuation"]');
    expect(text).toContain("consumed on resume");
    expect(text).toContain(
      "Using continue-here as the durable interview phase/approval-scope carrier (#5352)",
    );
  });
});
