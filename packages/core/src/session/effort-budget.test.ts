import { describe, expect, it } from "vitest";
import {
  detectHardEffortBudget,
  ENV_HARD_BUDGET,
  ENV_MAX_BUDGET,
  ENV_MAX_TURNS,
  ENV_REMAINING_BUDGET,
  ENV_REMAINING_TURNS,
  effortBudgetToDict,
  formatDeepeningSkippedNote,
  formatEffortBudgetLines,
  maybeFormatEffortBudgetLines,
  recommendVerificationDepth,
} from "./effort-budget.js";

describe("detectHardEffortBudget (#3266)", () => {
  it("defaults to unbounded when no signals", () => {
    const budget = detectHardEffortBudget({ environ: {} });
    expect(budget.detected).toBe(false);
    expect(budget.posture).toBe("unbounded");
    expect(budget.kind).toBe("none");
    expect(budget.maxTurns).toBeNull();
    expect(budget.sources).toEqual([]);
  });

  it("detects DEFT_MAX_TURNS as hard max-turns", () => {
    const budget = detectHardEffortBudget({
      environ: { [ENV_MAX_TURNS]: "120" },
    });
    expect(budget.detected).toBe(true);
    expect(budget.posture).toBe("hard-capped");
    expect(budget.kind).toBe("max-turns");
    expect(budget.maxTurns).toBe(120);
    expect(budget.remainingTurns).toBe(120);
    expect(budget.sources).toContain(`env:${ENV_MAX_TURNS}`);
  });

  it("accepts MAX_TURNS alias", () => {
    const budget = detectHardEffortBudget({
      environ: { MAX_TURNS: "40" },
    });
    expect(budget.maxTurns).toBe(40);
    expect(budget.kind).toBe("max-turns");
    expect(budget.sources).toContain("env:MAX_TURNS");
  });

  it("detects max cost budget", () => {
    const budget = detectHardEffortBudget({
      environ: { [ENV_MAX_BUDGET]: "25.5" },
    });
    expect(budget.kind).toBe("max-cost");
    expect(budget.maxBudget).toBe(25.5);
  });

  it("detects both turns and cost", () => {
    const budget = detectHardEffortBudget({
      environ: {
        [ENV_MAX_TURNS]: "100",
        [ENV_MAX_BUDGET]: "10",
      },
    });
    expect(budget.kind).toBe("both");
    expect(budget.maxTurns).toBe(100);
    expect(budget.maxBudget).toBe(10);
  });

  it("honors remaining turns/budget overrides", () => {
    const budget = detectHardEffortBudget({
      environ: {
        [ENV_MAX_TURNS]: "100",
        [ENV_REMAINING_TURNS]: "12",
        [ENV_MAX_BUDGET]: "50",
        [ENV_REMAINING_BUDGET]: "4",
      },
    });
    expect(budget.remainingTurns).toBe(12);
    expect(budget.remainingBudget).toBe(4);
    expect(budget.sources).toEqual(
      expect.arrayContaining([
        `env:${ENV_MAX_TURNS}`,
        `env:${ENV_REMAINING_TURNS}`,
        `env:${ENV_MAX_BUDGET}`,
        `env:${ENV_REMAINING_BUDGET}`,
      ]),
    );
  });

  it("detects hard-flag without numeric ceiling", () => {
    const budget = detectHardEffortBudget({
      environ: { [ENV_HARD_BUDGET]: "true" },
    });
    expect(budget.detected).toBe(true);
    expect(budget.kind).toBe("hard-flag");
    expect(budget.maxTurns).toBeNull();
  });

  it("reads host capability descriptor (#1461 pointer)", () => {
    const budget = detectHardEffortBudget({
      environ: {},
      hostDescriptor: { maxTurns: 80, hardBudget: true },
    });
    expect(budget.maxTurns).toBe(80);
    expect(budget.kind).toBe("max-turns");
    expect(budget.sources).toContain("host:maxTurns");
  });

  it("prefers env over host for the same signal", () => {
    const budget = detectHardEffortBudget({
      environ: { [ENV_MAX_TURNS]: "50" },
      hostDescriptor: { max_turns: 999 },
    });
    expect(budget.maxTurns).toBe(50);
    expect(budget.sources).toContain(`env:${ENV_MAX_TURNS}`);
    expect(budget.sources).not.toContain("host:max_turns");
  });

  it("rejects negative and non-numeric values", () => {
    expect(
      detectHardEffortBudget({ environ: { [ENV_MAX_TURNS]: "-1" } }).detected,
    ).toBe(false);
    expect(
      detectHardEffortBudget({ environ: { [ENV_MAX_TURNS]: "nope" } }).detected,
    ).toBe(false);
  });
});

describe("recommendVerificationDepth (#3266)", () => {
  const hard = detectHardEffortBudget({ environ: { [ENV_MAX_TURNS]: "120" } });

  it("unbounded → unconstrained-deepen", () => {
    const open = detectHardEffortBudget({ environ: {} });
    expect(
      recommendVerificationDepth({ budget: open, statedAcceptanceMet: false }),
    ).toBe("unconstrained-deepen");
    expect(
      recommendVerificationDepth({ budget: open, statedAcceptanceMet: true }),
    ).toBe("unconstrained-deepen");
  });

  it("hard budget + AC open → stated-only (bank the pass first)", () => {
    expect(
      recommendVerificationDepth({ budget: hard, statedAcceptanceMet: false }),
    ).toBe("stated-only");
  });

  it("hard budget + AC met + enough remaining → stated-then-deepen", () => {
    const mid = detectHardEffortBudget({
      environ: {
        [ENV_MAX_TURNS]: "120",
        [ENV_REMAINING_TURNS]: "40",
      },
    });
    expect(
      recommendVerificationDepth({ budget: mid, statedAcceptanceMet: true }),
    ).toBe("stated-then-deepen");
  });

  it("hard budget + AC met + low remaining → stated-only (skip deepen)", () => {
    const low = detectHardEffortBudget({
      environ: {
        [ENV_MAX_TURNS]: "120",
        [ENV_REMAINING_TURNS]: "2",
      },
    });
    expect(
      recommendVerificationDepth({
        budget: low,
        statedAcceptanceMet: true,
        deepenReserveTurns: 3,
      }),
    ).toBe("stated-only");
  });

  it("hard-flag after AC met → stated-then-deepen (agent still fail-louds skip)", () => {
    const flag = detectHardEffortBudget({
      environ: { [ENV_HARD_BUDGET]: "1" },
    });
    expect(
      recommendVerificationDepth({ budget: flag, statedAcceptanceMet: true }),
    ).toBe("stated-then-deepen");
  });
});

describe("format + dict surfaces (#3266)", () => {
  it("formatEffortBudgetLines emits bank-the-pass when hard-capped", () => {
    const budget = detectHardEffortBudget({
      environ: { [ENV_MAX_TURNS]: "120" },
    });
    const lines = formatEffortBudgetLines(budget);
    expect(lines[0]).toContain("hard-capped");
    expect(lines[0]).toContain("max_turns=120");
    expect(lines.some((l) => l.includes("bank stated acceptance"))).toBe(true);
  });

  it("formatEffortBudgetLines reports unbounded", () => {
    const lines = formatEffortBudgetLines(detectHardEffortBudget({ environ: {} }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("unbounded");
  });

  it("formatDeepeningSkippedNote is fail-loud (#1006)", () => {
    const budget = detectHardEffortBudget({
      environ: { [ENV_MAX_TURNS]: "10", [ENV_REMAINING_TURNS]: "1" },
    });
    const note = formatDeepeningSkippedNote(budget);
    expect(note).toContain("deepening_skipped=true");
    expect(note).toContain("#1006");
    expect(note).toContain("remaining_turns=1");
  });

  it("effortBudgetToDict is stable snake_case", () => {
    const budget = detectHardEffortBudget({
      environ: { [ENV_MAX_TURNS]: "5" },
    });
    expect(effortBudgetToDict(budget)).toMatchObject({
      detected: true,
      posture: "hard-capped",
      kind: "max-turns",
      max_turns: 5,
    });
  });

  it("maybeFormatEffortBudgetLines pairs budget + lines", () => {
    const { budget, lines } = maybeFormatEffortBudgetLines({
      environ: { [ENV_MAX_BUDGET]: "3" },
    });
    expect(budget.kind).toBe("max-cost");
    expect(lines[0]).toContain("max_budget=3");
  });
});
