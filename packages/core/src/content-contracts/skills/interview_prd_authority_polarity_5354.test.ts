/**
 * Prefer-A Bound polarity lock for #5354:
 * interview strategy must not reintroduce PRD-as-approval-gate or
 * promote-on-approval while setup/interview forbid those paths.
 */
import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers.js";

const STRATEGY_RENDERED = "strategies/interview.md";
const STRATEGY_PACK = "packs/strategies/strategies-pack-0.1.json";
const SETUP_SKILL = "skills/deft-directive-setup/SKILL.md";
const INTERVIEW_SKILL = "skills/deft-directive-interview/SKILL.md";
const MAKE_SPEC = "templates/make-spec.md";

function packedInterviewBody(): string {
  const pack = JSON.parse(readRepoFile(STRATEGY_PACK)) as {
    strategies: Array<{ id: string; body: string }>;
  };
  const interview = pack.strategies.find((s) => s.id === "interview");
  if (interview === undefined) throw new Error("interview pack entry missing");
  return interview.body;
}

function assertNoPrdApprovalGate(surface: string, text: string): void {
  expect(text, surface).not.toContain("Generate `PRD.md` — user approval gate");
  expect(text, surface).not.toContain("What to build (approval gate)");
  expect(text, surface).not.toContain("PRD (approval gate)");
  expect(text, surface).not.toContain("Interview → PRD →");
  expect(text, surface).not.toMatch(/User MUST review and approve the rendered PRD export/i);
  // Workflow Overview must not route Full path through a PRD approval gate (#5354).
  expect(text, surface).not.toContain('P -->|"Approved"| S');
  expect(text, surface).not.toContain("PRD<br/><i>What to build</i>");
  expect(text, surface).not.toContain("Brief summary and link to PRD.");
  // Shared Light+Full optional-export edge is forbidden (#5354).
  expect(text, surface).not.toContain('PD -. "optional export" .-> R');
}

function assertWorkflowOverviewPolarity(surface: string, text: string): void {
  assertNoPrdApprovalGate(surface, text);
  // Optional PRD export is Full-only in the strategy diagram (#5354).
  expect(text, surface).toContain("Full only: optional export");
  expect(text, surface).toContain("PD_F");
}

function assertNoPromoteOnApproval(surface: string, text: string): void {
  expect(text, surface).not.toMatch(/On (user )?approval, use `task scope:promote`/i);
  expect(text, surface).not.toContain("On approval, use `task scope:promote` (or equivalent)");
}

describe("interview PRD authority / promote polarity (#5354)", () => {
  const packed = packedInterviewBody();
  const rendered = readRepoFile(STRATEGY_RENDERED);
  const setup = readRepoFile(SETUP_SKILL);
  const interviewSkill = readRepoFile(INTERVIEW_SKILL);
  const makeSpec = readRepoFile(MAKE_SPEC);

  for (const [surface, text] of [
    ["packed strategy", packed],
    ["rendered strategy", rendered],
  ] as const) {
    it(`${surface} Full path does not instruct PRD-as-approval-gate`, () => {
      assertWorkflowOverviewPolarity(surface, text);
      expect(text).toContain("never authoritative");
      expect(text).toContain("task prd:render");
      expect(text).toContain("⊗ Create a separate PRD.md on the Light path");
    });

    it(`${surface} Light/Full approval stops at proposed (no promote-on-approval)`, () => {
      assertNoPromoteOnApproval(surface, text);
      expect(text).toContain("leave scope record(s) in `proposed/`");
      expect(text).toContain(
        "⊗ Auto-run `task scope:promote` or `task scope:activate` as the effect of approving planning artifacts",
      );
    });
  }

  it("setup still forbids authoritative PRD and auto promote/activate from Phase 3", () => {
    expect(setup).toContain("⊗ Generate an authoritative PRD.md");
    expect(setup).toContain("task prd:render");
    expect(setup).toContain(
      "⊗ Auto-run `task scope:promote` or `task scope:activate` from the setup skill on the Phase 3 outputs",
    );
  });

  it("interview skill still treats PRD.md as never authoritative", () => {
    expect(interviewSkill).toContain("PRD.md is never authoritative");
    expect(interviewSkill).toContain("⊗ Generate an authoritative PRD.md");
  });

  it("make-spec entry point matches strategy polarity", () => {
    assertNoPrdApprovalGate("make-spec", makeSpec);
    assertNoPromoteOnApproval("make-spec", makeSpec);
    expect(makeSpec).toContain("rendered PRD export");
    expect(makeSpec).toContain("rendered PRD/SPEC files are exports");
    expect(makeSpec).toContain("leave scopes in `proposed/`");
  });

  it("three-way lock: strategy does not contradict setup/interview polarity", () => {
    const strategySurfaces = [packed, rendered];
    for (const text of strategySurfaces) {
      assertWorkflowOverviewPolarity("strategy", text);
      assertNoPromoteOnApproval("strategy", text);
    }
    expect(setup).toMatch(/authoritative PRD\.md/i);
    expect(setup).toMatch(/Auto-run `task scope:promote`/i);
    expect(interviewSkill).toMatch(/PRD\.md is never authoritative/i);
  });
});
