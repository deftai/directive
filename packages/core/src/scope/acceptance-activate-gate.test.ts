import { describe, expect, it } from "vitest";
import {
  collectAcceptanceShapedNarrativeKeys,
  evaluateAcceptanceActivateGate,
} from "./acceptance-activate-gate.js";

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
    expect(gate.message).toMatch(/Stamp plan\.acceptance/);
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
