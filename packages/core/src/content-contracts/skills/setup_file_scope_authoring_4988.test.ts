import { describe, expect, it } from "vitest";
import { missingRequiredSwarmFields } from "../../vbrief-validation/story-quality.js";
import { readRepoFile } from "./helpers.js";

const SETUP_SKILL = "skills/deft-directive-setup/SKILL.md";
const PACK = "packs/skills/skills-pack-0.1.json";

function packedSetupBody(): string {
  const pack = JSON.parse(readRepoFile(PACK)) as {
    skills: Array<{ id: string; body: string }>;
  };
  const setup = pack.skills.find((skill) => skill.id === "deft-directive-setup");
  if (setup === undefined) throw new Error("deft-directive-setup pack entry missing");
  return setup.body;
}

function setupSurfaces(): string[] {
  return [packedSetupBody(), readRepoFile(SETUP_SKILL)];
}

function onboardingQuestion(text: string): string {
  const start = text.indexOf("### Onboarding Question");
  expect(start).not.toBe(-1);
  const end = text.indexOf("### ⚠️ MANDATORY: Strategy Gate", start);
  expect(end).not.toBe(-1);
  return text.slice(start, end);
}

function strategyGateThroughDivider(text: string): string {
  const start = text.indexOf("### ⚠️ MANDATORY: Strategy Gate");
  expect(start).not.toBe(-1);
  const end = text.indexOf("Everything below applies ONLY to the interview strategy", start);
  expect(end).not.toBe(-1);
  return text.slice(start, end);
}

function confirmationGate(text: string): string {
  const start = text.indexOf("## Post-Interview Confirmation Gate");
  expect(start).not.toBe(-1);
  const end = text.indexOf("## Anti-Patterns", start);
  expect(end).not.toBe(-1);
  return text.slice(start, end);
}

function fileScopeAuthoringBlock(text: string): string {
  const start = text.indexOf("### plan.acceptance exclusive writer");
  expect(start).not.toBe(-1);
  const end = text.indexOf("### Intent-constraint plan key", start);
  expect(end).not.toBe(-1);
  return text.slice(start, end);
}

/** Affirmative approved-scope mint/action lines (forbid polarity may remain). */
function affirmativeApprovedScopeSetupActions(text: string): string[] {
  const hits: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (
      !/(scope:record-approved-scope|approved-scope digest|\.deft\/approved-scope\/)/i.test(line)
    ) {
      continue;
    }
    if (/[⊗]|MUST NOT|Forbid polarity|forbid polarity|no longer describe/i.test(line)) {
      continue;
    }
    if (
      /intent-constraint|scope:record-intent-constraint|scope:record-observable-scope/i.test(line)
    ) {
      continue;
    }
    hits.push(line);
  }
  return hits;
}

describe("setup file_scope authoring (#4988)", () => {
  it("Add-scope and Rapid collect operator-named file_scope before writing", () => {
    for (const surface of setupSurfaces()) {
      const add = onboardingQuestion(surface);
      expect(add).toMatch(/If \*\*Add scope\*\*[\s\S]*per-scope path question/);
      expect(add).toMatch(/If \*\*Add scope\*\*[\s\S]*plan\.metadata\.swarm\.file_scope/);
      expect(add).toMatch(/#4988/);

      const rapid = strategyGateThroughDivider(surface);
      expect(rapid).toMatch(/Before writing that draft[\s\S]*per-scope path question/);
      expect(rapid).toMatch(/Before writing that draft[\s\S]*plan\.metadata\.swarm\.file_scope/);
      expect(rapid).toContain("Scope path collect (every scope-emitting branch)");
      expect(rapid).toMatch(/Add-scope, Rapid, Light, and Full/);
      expect(rapid).toMatch(
        /Skip path collect because Add-scope or Rapid skipped the full interview/,
      );
    }
  });

  it("requires non-empty operator-named file_scope at authoring and forbids invent/auto-fill", () => {
    for (const surface of setupSurfaces()) {
      const block = fileScopeAuthoringBlock(surface);
      expect(block).toMatch(/non-empty `plan\.metadata\.swarm\.file_scope`/);
      expect(block).toMatch(/operator-named path members only/);
      expect(block).toMatch(/#4988/);
      expect(block).toMatch(/Auto-fill or derive/);
      expect(block).toMatch(/Invent paths/);
      expect(block).toMatch(/explicit per-scope path question/);
      expect(block).toMatch(/every scope-emitting setup branch/);
      expect(block).toMatch(/Add-scope, and Rapid/);
    }
  });

  it("confirmation gate lists each scope paths as display and keeps write-files lexicon", () => {
    for (const surface of setupSurfaces()) {
      const gate = confirmationGate(surface);
      expect(gate).toMatch(/under that scope/);
      expect(gate).toMatch(/file_scope/);
      expect(gate).toContain("Write files? (yes/no)");
      expect(gate).toContain("`yes`, `confirmed`, `approve`");
      expect(gate).toMatch(/approved-scope approval verb/);
      expect(gate).not.toMatch(/scope:record-approved-scope --/);
    }
  });

  it("does not describe approved-scope mint as a setup action; forbid polarity may remain", () => {
    for (const surface of setupSurfaces()) {
      expect(affirmativeApprovedScopeSetupActions(surface)).toEqual([]);
      expect(surface).toMatch(
        /Describe a mint step, a digest, or `scope:record-approved-scope` as a setup action/,
      );
    }
  });

  it("requires the same file_scope presence check decompose already imposes", () => {
    for (const surface of setupSurfaces()) {
      expect(surface).toMatch(/same `file_scope` presence check decompose already imposes/);
      expect(surface).toMatch(/operative surface is presence/);
    }
    expect(missingRequiredSwarmFields({})).toContain("plan.metadata.swarm.file_scope");
    expect(
      missingRequiredSwarmFields({ file_scope: ["content/skills/deft-directive-setup/SKILL.md"] }),
    ).not.toContain("plan.metadata.swarm.file_scope");
  });
});
