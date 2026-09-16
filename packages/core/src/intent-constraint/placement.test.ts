/**
 * Authorship-time placement for intent-constraint mint (#4587).
 *
 * Does not recut evaluateIntentConstraint. Proves the worker-facing fail
 * string names scope:record-intent-constraint, skills/templates place the
 * operator ask at plan-key authorship, and C1/headless fail-closed is stated
 * without a paste-ready mint argv.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { remedyForGate } from "../check/named-cause.js";
import { INTENT_CONSTRAINT_REMEDIATION } from "./types.js";

const ROOT = process.cwd();

function readRepo(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("intent-constraint authorship placement (#4587)", () => {
  it("names scope:record-intent-constraint on the task-check fail string", () => {
    expect(INTENT_CONSTRAINT_REMEDIATION).toContain("scope:record-intent-constraint");
    expect(INTENT_CONSTRAINT_REMEDIATION).toContain("INTENT_CONSTRAINT_MISSING");
    expect(INTENT_CONSTRAINT_REMEDIATION).toMatch(/Tests and in-scope file paths are not authority/);
    expect(remedyForGate("verify:intent-constraint", "no merge-base mint")).toContain(
      "scope:record-intent-constraint",
    );
  });

  it("states C1/headless fail-closed without a paste-ready mint argv", () => {
    expect(INTENT_CONSTRAINT_REMEDIATION).toMatch(/Headless\/C1/);
    expect(INTENT_CONSTRAINT_REMEDIATION).toMatch(/fails closed/);
    expect(INTENT_CONSTRAINT_REMEDIATION).toMatch(/no operator on the TTY/);
    expect(INTENT_CONSTRAINT_REMEDIATION).not.toMatch(/--actor/);
    expect(INTENT_CONSTRAINT_REMEDIATION).not.toMatch(/--confirm/);
    expect(INTENT_CONSTRAINT_REMEDIATION).not.toMatch(/<xbrief/);
    const named = remedyForGate("verify:intent-constraint", "no merge-base mint");
    expect(named).toMatch(/fails closed/);
    expect(named).not.toMatch(/--actor/);
    expect(named).not.toMatch(/--confirm/);
  });

  it("keeps merge-base snapshot authority and does not recut evaluate", () => {
    const evaluate = readRepo("packages/core/src/intent-constraint/evaluate.ts");
    expect(evaluate).toContain("same-PR rewrite");
    expect(evaluate).toContain("INTENT_CONSTRAINT_DIR");
    expect(evaluate).toMatch(/git show/);
    expect(evaluate).not.toMatch(/approved-scope/);
    expect(evaluate).toContain("evaluateIntentConstraint");
  });

  it("places the operator ask at plan-key authorship, not at record-approved-scope", () => {
    const setup = readRepo("content/skills/deft-directive-setup/SKILL.md");
    const build = readRepo("content/skills/deft-directive-build/SKILL.md");
    const phase0 = readRepo("content/skills/deft-directive-swarm/references/core-phase-0.md");
    const preamble = readRepo("content/templates/agent-prompt-preamble.md");
    const docs = readRepo("content/docs/intent-constraint.md");

    for (const text of [setup, build, phase0, preamble, docs]) {
      expect(text).toContain("scope:record-intent-constraint");
    }

    expect(setup).toContain('plan["x-directive/intentConstraint"]');
    expect(setup).toMatch(/at authorship/);
    expect(setup).toMatch(/Fill speculative/);
    expect(preamble).toContain('plan["x-directive/intentConstraint"]');
    expect(docs).toContain("INTENT_CONSTRAINT_MISSING");
    expect(docs).toMatch(/Headless\/C1|headless\/C1|C1\/headless/);

    expect(phase0).toMatch(/Ask for .scope:record-intent-constraint/);
    expect(build).toMatch(/fails closed with no operator on the TTY/);
    expect(build).toMatch(/Paste a mint argv/);
  });
});
