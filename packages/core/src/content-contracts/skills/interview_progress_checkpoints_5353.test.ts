import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers.js";

const INTERVIEW = "skills/deft-directive-interview/SKILL.md";
const SETUP = "skills/deft-directive-setup/SKILL.md";

function progressSection(text: string): string {
  const start = text.indexOf("### Progress Checkpoints (#5353)");
  expect(start).not.toBe(-1);
  const end = text.indexOf('### Rule 3: Explicit "Other / I Don\'t Know" Escape', start);
  expect(end).not.toBe(-1);
  return text.slice(start, end);
}

function phase1InterviewRules(text: string): string {
  const start = text.indexOf("### Interview Rules\n");
  expect(start).not.toBe(-1);
  const end = text.indexOf("### Question Sequence", start);
  expect(end).not.toBe(-1);
  return text.slice(start, end);
}

function phase2InterviewRules(text: string): string {
  const start = text.indexOf("### Interview Rules (same as Phase 1)");
  expect(start).not.toBe(-1);
  const end = text.indexOf("### Question Sequence", start);
  expect(end).not.toBe(-1);
  return text.slice(start, end);
}

describe("interview progress checkpoints (#5353)", () => {
  it("interview skill binds Rule 2 status-only checkpoints with Rule 1 coexistence", () => {
    const text = readRepoFile(INTERVIEW);
    const section = progressSection(text);
    expect(section).toContain("agent-initiated status updates that do NOT ask the user to choose anything");
    expect(section).toContain("outside the tool `question` field");
    expect(section).toContain("inventory labels");
    expect(section).toContain("`⊗ List upcoming questions`");
    expect(text).toContain("Progress checkpoints (#5353) coexist with these forbids");
  });

  it("closed triggers + fill-vs-addition + how-much-is-left interrupt", () => {
    const section = progressSection(readRepoFile(INTERVIEW));
    expect(section).toContain("phase entry / phase exit");
    expect(section).toContain("after a material decision-area is **added**");
    expect(section).toContain("ordinary fill of an existing calling-skill field");
    expect(section).toContain("after an accepted deferral is recorded");
    expect(section).toContain("before Rule 6 confirmation gate");
    expect(section).toContain("on operator how-much-is-left");
    expect(section).toContain("re-render the same pending question");
    expect(section).toContain("Do not open Discuss unless the operator chose Discuss");
    expect(section).toContain("⊗ Emit a checkpoint on ordinary field-fill alone");
    expect(section).toContain("⊗ Remove Rule 8 or switch to yolo");
  });

  it("multi-topic acceptance fixture clauses are stated", () => {
    const section = progressSection(readRepoFile(INTERVIEW));
    expect(section).toContain("#### Acceptance / regression fixture (#5353)");
    expect(section).toContain("status-only checkpoint at each closed trigger");
    expect(section).toContain("no upcoming concrete question list");
    expect(section).toContain("addition-with-reason visible on runtime inventory append");
    expect(section).toContain("no checkpoint on ordinary field-fill alone");
    expect(section).toContain("how-much-is-left → status then same-question re-render");
    expect(section).toContain("short path has no every-turn recap");
    expect(section).toContain("accepted deferrals visible");
    expect(section).toContain("shared-turn checkpoint prose stays outside the structured tool `question` field");
  });

  it("setup Phase 1 and Phase 2 Interview Rules mirror duty + coexistence", () => {
    const text = readRepoFile(SETUP);
    const p1 = phase1InterviewRules(text);
    const p2 = phase2InterviewRules(text);
    for (const block of [p1, p2]) {
      expect(block).toContain("Progress checkpoints (#5353)");
      expect(block).toContain("Rule 2 status-only");
      expect(block).toContain("how-much-is-left");
      expect(block).toContain("outside the tool `question` field");
      expect(block).toContain("Progress status is not a second question");
      expect(block).toContain("⊗ List upcoming questions");
    }
    // S3: Phase 2 must paste duty, not leave a pointer-only stub
    expect(p2).toContain("addition-with-reason");
    expect(p2).toContain("do not remove Rule 8 or switch to yolo");
  });
});
