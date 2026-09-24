/**
 * Authorship-time placement for intent-constraint (#4587 / #5010).
 *
 * Does not recut evaluateIntentConstraint. Proves the worker-facing fail
 * string prefers detect + in-harness ask / rewrite-park over leave-harness
 * TTY mint, skills/templates place the operator ask at plan-key authorship,
 * and C1/unattended fail closed without a paste-ready mint argv.
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

describe("intent-constraint authorship placement (#4587 / #5010)", () => {
  it("names in-harness ask / rewrite-park as the primary task-check fail path", () => {
    expect(INTENT_CONSTRAINT_REMEDIATION).toContain("INTENT_CONSTRAINT_MISSING");
    expect(INTENT_CONSTRAINT_REMEDIATION).toMatch(/parent chat|in-harness-ask/);
    expect(INTENT_CONSTRAINT_REMEDIATION).toMatch(/rewrite or park/);
    expect(INTENT_CONSTRAINT_REMEDIATION).toMatch(/legacy repair only/);
    expect(INTENT_CONSTRAINT_REMEDIATION).toMatch(
      /Tests and in-scope file paths are not authority/,
    );
    expect(INTENT_CONSTRAINT_REMEDIATION).toContain("scope:record-intent-constraint");
    const named = remedyForGate("verify:intent-constraint", "no merge-base mint");
    expect(named).toMatch(/parent chat|in-harness-ask/);
    expect(named).toMatch(/rewrite or park/);
    expect(named).toContain("scope:record-intent-constraint");
  });

  it("states unattended fail-closed without a paste-ready mint argv", () => {
    expect(INTENT_CONSTRAINT_REMEDIATION).toMatch(/Unattended\/C1/);
    expect(INTENT_CONSTRAINT_REMEDIATION).toMatch(/rewrite or park/);
    expect(INTENT_CONSTRAINT_REMEDIATION).toMatch(/do not ask an empty room/);
    expect(INTENT_CONSTRAINT_REMEDIATION).not.toMatch(/--actor/);
    expect(INTENT_CONSTRAINT_REMEDIATION).not.toMatch(/--confirm/);
    expect(INTENT_CONSTRAINT_REMEDIATION).not.toMatch(/<xbrief/);
    const named = remedyForGate("verify:intent-constraint", "no merge-base mint");
    expect(named).toMatch(/rewrite or park/);
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

  it("places the operator ask at plan-key authorship, not leave-harness TTY mint", () => {
    const setup = readRepo("content/skills/deft-directive-setup/SKILL.md");
    const build = readRepo("content/skills/deft-directive-build/SKILL.md");
    const phase0 = readRepo("content/skills/deft-directive-swarm/references/core-phase-0.md");
    const preamble = readRepo("content/templates/agent-prompt-preamble.md");
    const docs = readRepo("content/docs/intent-constraint.md");

    for (const text of [setup, build, phase0, preamble, docs]) {
      expect(text).toContain("scope:record-intent-constraint");
      expect(text).toMatch(/in-harness|parent chat/);
    }

    expect(setup).toContain('plan["x-directive/intentConstraint"]');
    expect(setup).toMatch(/at authorship/);
    expect(setup).toMatch(/Fill speculative/);
    expect(preamble).toContain('plan["x-directive/intentConstraint"]');
    expect(docs).toContain("INTENT_CONSTRAINT_MISSING");
    expect(docs).toMatch(/Unattended|unattended|C1/);

    expect(phase0).toMatch(
      /Ask for leave-harness TTY .scope:record-intent-constraint|leave-harness TTY .scope:record-intent-constraint/,
    );
    expect(build).toMatch(/rewrite or park|legacy repair only/);
    expect(build).toMatch(/Paste a mint argv/);
  });
});
