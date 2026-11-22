/**
 * Authorship-time placement for intent-constraint (#4587 / #5010 / #7031).
 *
 * Does not recut evaluateIntentConstraint. Proves the worker-facing fail
 * string and the skills/templates say: write the declaration with
 * `scope:record-intent-constraint` and land it on the merge base before the
 * product PR (#7031), instead of parking for a human terminal mint.
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

describe("intent-constraint authorship placement (#4587 / #5010 / #7031)", () => {
  it("names write-the-declaration as the task-check fail path", () => {
    expect(INTENT_CONSTRAINT_REMEDIATION).toContain("INTENT_CONSTRAINT_MISSING");
    expect(INTENT_CONSTRAINT_REMEDIATION).toMatch(/Write the declaration/);
    expect(INTENT_CONSTRAINT_REMEDIATION).toMatch(/from any shell/);
    expect(INTENT_CONSTRAINT_REMEDIATION).toMatch(/before the product PR/);
    expect(INTENT_CONSTRAINT_REMEDIATION).toMatch(
      /delivery-branch merge base|rebase the implementation branch/,
    );
    expect(INTENT_CONSTRAINT_REMEDIATION).toMatch(
      /Tests and in-scope file paths are not authority/,
    );
    expect(INTENT_CONSTRAINT_REMEDIATION).toContain("scope:record-intent-constraint");
    expect(INTENT_CONSTRAINT_REMEDIATION).toMatch(
      /Classify the condition|invariant \/ corruption \/ impossible-if-healthy/,
    );
    expect(INTENT_CONSTRAINT_REMEDIATION).toMatch(/rewrite solely to clear the gate is forbidden/);
    const named = remedyForGate("verify:intent-constraint", "no merge-base record");
    expect(named).toMatch(/Write the declaration/);
    expect(named).toContain("scope:record-intent-constraint");
  });

  it("does not park for a human mint and keeps the no-soften rule", () => {
    expect(INTENT_CONSTRAINT_REMEDIATION).not.toMatch(/park pending a human mint/);
    expect(INTENT_CONSTRAINT_REMEDIATION).not.toMatch(/real TTY|agent\/CI shells still refuse/);
    expect(INTENT_CONSTRAINT_REMEDIATION).toMatch(/A declaration is not consent/);
    expect(INTENT_CONSTRAINT_REMEDIATION).toMatch(
      /Do not soften\/remove an invariant failure solely to clear the gate/,
    );
    expect(INTENT_CONSTRAINT_REMEDIATION).not.toMatch(/--actor/);
    expect(INTENT_CONSTRAINT_REMEDIATION).not.toMatch(/--confirm/);
    expect(INTENT_CONSTRAINT_REMEDIATION).not.toMatch(/<xbrief/);
  });

  it("keeps merge-base snapshot authority and does not recut evaluate", () => {
    const evaluate = readRepo("packages/core/src/intent-constraint/evaluate.ts");
    expect(evaluate).toContain("same-PR rewrite");
    expect(evaluate).toContain("INTENT_CONSTRAINT_DIR");
    expect(evaluate).toMatch(/git show/);
    expect(evaluate).not.toMatch(/approved-scope/);
    expect(evaluate).toContain("evaluateIntentConstraint");
  });

  it("places the declaration at plan-key authorship, landed before the product PR", () => {
    const setup = readRepo("content/skills/deft-directive-setup/SKILL.md");
    const build = readRepo("content/skills/deft-directive-build/SKILL.md");
    const phase0 = readRepo("content/skills/deft-directive-swarm/references/core-phase-0.md");
    const preamble = readRepo("content/templates/agent-prompt-preamble.md");
    const docs = readRepo("content/docs/intent-constraint.md");

    for (const text of [setup, build, phase0, preamble, docs]) {
      expect(text).toContain("scope:record-intent-constraint");
      expect(text).toMatch(/write the declaration/i);
      expect(text).toMatch(/before the (implementation|product) PR/);
      expect(text).not.toMatch(/park pending a human mint/);
    }

    expect(setup).toContain('plan["x-directive/intentConstraint"]');
    expect(setup).toMatch(/at authorship/);
    expect(setup).toMatch(/Fill speculative/);
    expect(preamble).toContain('plan["x-directive/intentConstraint"]');
    expect(docs).toContain("INTENT_CONSTRAINT_MISSING");
    expect(docs).toMatch(/Failure-handling split|#5574 Prefer-A/);
    expect(docs).toMatch(/impossible-if-healthy/);
    expect(docs).toMatch(/returned-failure|operational deny|missing grant/);
    expect(docs).toMatch(/FACT_KINDS|numeric-const/);
    for (const text of [preamble, phase0, build]) {
      expect(text).toMatch(/impossible-if-healthy/);
      expect(text).toMatch(/returned-failure|operational deny/);
      expect(text).toMatch(/not consent/);
      expect(text).toMatch(/[Dd]o not soften|Soften an invariant/);
    }
  });
});
