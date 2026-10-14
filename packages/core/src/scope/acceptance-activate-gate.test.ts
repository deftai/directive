import { describe, expect, it } from "vitest";
import { readAcceptanceClauses } from "../verify-ac/clauses.js";
import {
  collectAcceptanceShapedNarrativeKeys,
  evaluateAcceptanceActivateGate,
  prepareActiveIngressAcceptance,
} from "./acceptance-activate-gate.js";
import { ACTIVE_ACCEPTANCE_ORACLES } from "./lifecycle-write.js";

describe("acceptance-activate-gate (#3334)", () => {
  it("allows activate when narratives omit acceptance-shaped keys", () => {
    const gate = evaluateAcceptanceActivateGate({
      title: "t",
      narratives: { Overview: "plain story" },
    });
    expect(gate.ok).toBe(true);
    expect(gate.hits).toEqual([]);
  });

  it("allows activate when plan.acceptance is already stamped", () => {
    const gate = evaluateAcceptanceActivateGate({
      narratives: { Test: "pnpm test should pass" },
      acceptance: { commands: [], none_stated: true, source_rung: "project_floor" },
    });
    expect(gate.ok).toBe(true);
    expect(gate.hits.map((h) => h.key)).toEqual(["Test"]);
  });

  it("refuses activate with one remediation when narratives are acceptance-shaped", () => {
    const gate = evaluateAcceptanceActivateGate({
      narratives: {
        AcceptanceCriteria: "the login form rejects empty passwords",
        Overview: "also here",
      },
    });
    expect(gate.ok).toBe(false);
    expect(gate.message).toMatch(/plan\.acceptance is absent \(#3334\)/);
    expect(gate.message).toMatch(/Stamp plan\.acceptance via clause derivation/);
    expect(gate.message).toMatch(
      /0 clauses derived from acceptance-shaped narrative keys \(AcceptanceCriteria\)/,
    );
    expect(gate.message).toMatch(/Bare prose is not derivable \(#4374\)/);
    expect(gate.message.split("Stamp plan.acceptance")).toHaveLength(2);
    expect(collectAcceptanceShapedNarrativeKeys({ Verification: "ok", Test: "  " })).toEqual([
      { key: "Verification" },
    ]);
  });

  it("refuses activate when plan.acceptance is present but invalid", () => {
    const gate = evaluateAcceptanceActivateGate({
      narratives: { Test: "pnpm test should pass" },
      acceptance: { commands: [], none_stated: false },
    });
    expect(gate.ok).toBe(false);
    expect(gate.message).toMatch(/plan\.acceptance is present but invalid \(#3334\)/);
    expect(gate.message).toMatch(/none_stated/);
  });
});

describe("active ingress acceptance (#4768 Prefer-A)", () => {
  it("names the three-oracle split without treating commands as DCR texts", () => {
    expect(ACTIVE_ACCEPTANCE_ORACLES.activateRefuse).toBe("usable-readAcceptanceClauses");
    expect(ACTIVE_ACCEPTANCE_ORACLES.verifyAcCommands).toBe(
      "stated-commands-may-pass-with-clause-count-0",
    );
    expect(ACTIVE_ACCEPTANCE_ORACLES.dcrTexts).toBe("non-empty-acceptance-text-commands-ignored");
  });

  it("allows bare / floor briefs without commands (not the Windows residual)", () => {
    const plan: Record<string, unknown> = {
      title: "T",
      acceptance: { commands: [], none_stated: true, source_rung: "project_floor" },
    };
    const result = prepareActiveIngressAcceptance(plan, { projectRoot: "/tmp/proj" });
    expect(result.ok).toBe(true);
    expect(result.applied).toBe(false);
    expect(readAcceptanceClauses(plan.acceptance)).toEqual([]);
  });

  it("refuses command-present / clause-text-empty when derivation cannot stamp text", () => {
    const plan: Record<string, unknown> = {
      title: "Initialize workers from the config",
      narratives: { Overview: "Initialize workers from the config" },
      acceptance: {
        commands: [{ command: "pnpm test" }],
        none_stated: false,
        source_rung: "stated",
      },
    };
    const result = prepareActiveIngressAcceptance(plan, { projectRoot: "/tmp/proj" });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/#4768 Prefer-A/);
    expect(result.message).toMatch(/commands alone are not acceptance texts/);
    expect(readAcceptanceClauses(plan.acceptance)).toEqual([]);
  });

  it("stamps usable clause text onto command-only acceptance when a list is derivable", () => {
    const plan: Record<string, unknown> = {
      title: "Command only",
      narratives: {
        Overview:
          "## Acceptance sketch\n- Persist the session token in packages/core/src/session/token.ts\n",
      },
      acceptance: {
        commands: [{ command: "pnpm test" }],
        none_stated: false,
        source_rung: "stated",
      },
    };
    const result = prepareActiveIngressAcceptance(plan, { projectRoot: "/tmp/proj" });
    expect(result.ok).toBe(true);
    expect(result.applied).toBe(true);
    const clauses = readAcceptanceClauses(plan.acceptance);
    expect(clauses.length).toBeGreaterThan(0);
    expect(clauses.every((c) => c.text.trim().length > 0)).toBe(true);
  });

  it("compares scanned artifact to readAcceptanceClauses — empty-text rows do not count", () => {
    const plan: Record<string, unknown> = {
      title: "Whitespace clause",
      acceptance: {
        commands: [{ command: "pnpm test" }],
        none_stated: false,
        source_rung: "stated",
        clauses: [{ id: 1, text: "   ", artifact_path: null, ambiguous: false }],
      },
    };
    const result = prepareActiveIngressAcceptance(plan, { projectRoot: "/tmp/proj" });
    expect(readAcceptanceClauses(plan.acceptance)).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/command-present \/ clause-text-empty/);
  });
});
