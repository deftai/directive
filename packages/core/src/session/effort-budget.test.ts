import { describe, expect, it } from "vitest";
import {
  detectHardEffortBudget,
  ENV_HARD_BUDGET,
  ENV_HOST_EFFORT_BUDGET,
  ENV_MAX_BUDGET,
  ENV_MAX_TURNS,
  ENV_REMAINING_BUDGET,
  ENV_REMAINING_TURNS,
  effortBudgetToDict,
  formatDeepeningSkippedNote,
  formatEffortBudgetLines,
  maybeFormatEffortBudgetLines,
  parseHostEffortBudgetEnv,
  recommendVerificationDepth,
  resolveProductionHostEffortDescriptor,
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
    expect(detectHardEffortBudget({ environ: { [ENV_MAX_TURNS]: "-1" } }).detected).toBe(false);
    expect(detectHardEffortBudget({ environ: { [ENV_MAX_TURNS]: "nope" } }).detected).toBe(false);
  });
});

describe("recommendVerificationDepth (#3266)", () => {
  const hard = detectHardEffortBudget({ environ: { [ENV_MAX_TURNS]: "120" } });

  it("unbounded → unconstrained-deepen", () => {
    const open = detectHardEffortBudget({ environ: {} });
    expect(recommendVerificationDepth({ budget: open, statedAcceptanceMet: false })).toBe(
      "unconstrained-deepen",
    );
    expect(recommendVerificationDepth({ budget: open, statedAcceptanceMet: true })).toBe(
      "unconstrained-deepen",
    );
  });

  it("hard budget + AC open → stated-only (bank the pass first)", () => {
    expect(recommendVerificationDepth({ budget: hard, statedAcceptanceMet: false })).toBe(
      "stated-only",
    );
  });

  it("hard budget + AC met + enough remaining → stated-then-deepen", () => {
    const mid = detectHardEffortBudget({
      environ: {
        [ENV_MAX_TURNS]: "120",
        [ENV_REMAINING_TURNS]: "40",
      },
    });
    expect(recommendVerificationDepth({ budget: mid, statedAcceptanceMet: true })).toBe(
      "stated-then-deepen",
    );
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
    expect(recommendVerificationDepth({ budget: flag, statedAcceptanceMet: true })).toBe(
      "stated-then-deepen",
    );
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

  it("format lines include remaining when they diverge from max", () => {
    const budget = detectHardEffortBudget({
      environ: {
        [ENV_MAX_TURNS]: "100",
        [ENV_REMAINING_TURNS]: "9",
        [ENV_MAX_BUDGET]: "50",
        [ENV_REMAINING_BUDGET]: "4",
      },
    });
    const line = formatEffortBudgetLines(budget)[0] ?? "";
    expect(line).toContain("remaining_turns=9");
    expect(line).toContain("remaining_budget=4");
  });

  it("formatDeepeningSkippedNote uses custom reason and remaining_budget path", () => {
    const budget = detectHardEffortBudget({
      environ: { [ENV_MAX_BUDGET]: "20", [ENV_REMAINING_BUDGET]: "1" },
    });
    const note = formatDeepeningSkippedNote(budget, "  tight cost  ");
    expect(note).toContain("reason=tight cost");
    expect(note).toContain("remaining_budget=1");
    expect(note).not.toContain("remaining_turns=");
  });

  it("formatDeepeningSkippedNote with no remaining and empty sources", () => {
    const flag = detectHardEffortBudget({ environ: { [ENV_HARD_BUDGET]: "yes" } });
    // Clear sources for empty-sources branch of the note formatter
    const bare = {
      ...flag,
      sources: [] as readonly string[],
      remainingTurns: null,
      remainingBudget: null,
    };
    const note = formatDeepeningSkippedNote(bare, "");
    expect(note).toContain("deepening_skipped=true");
    expect(note).not.toContain("sources=");
    expect(note).not.toContain("remaining_");
  });
});

describe("host descriptor edge branches (#3266)", () => {
  it("reads host max_budget string and hardBudget string/number flags", () => {
    const fromString = detectHardEffortBudget({
      environ: {},
      hostDescriptor: { max_budget: "7.5", hardBudget: "on" },
    });
    expect(fromString.kind).toBe("max-cost");
    expect(fromString.maxBudget).toBe(7.5);

    const fromNumFlag = detectHardEffortBudget({
      environ: {},
      hostDescriptor: { hasHardBudget: 1 },
    });
    expect(fromNumFlag.kind).toBe("hard-flag");
    expect(fromNumFlag.sources).toContain("host:hasHardBudget");
  });

  it("ignores non-finite host numbers and empty host strings", () => {
    const budget = detectHardEffortBudget({
      environ: {},
      hostDescriptor: { maxTurns: Number.NaN, max_turns: "", maxTurnLimit: -3 },
    });
    expect(budget.detected).toBe(false);
  });

  it("host maxCost fills when env absent; REMAINING_TURNS alias works", () => {
    const budget = detectHardEffortBudget({
      environ: { REMAINING_TURNS: "5" },
      hostDescriptor: { maxCost: 12 },
    });
    // Remaining turns alone count as a turns signal (#3266) → both with cost.
    expect(budget.kind).toBe("both");
    expect(budget.maxBudget).toBe(12);
    expect(budget.remainingTurns).toBe(5);
  });

  it("recommendVerificationDepth respects deepenReserveBudget", () => {
    const mid = detectHardEffortBudget({
      environ: {
        [ENV_MAX_TURNS]: "50",
        [ENV_REMAINING_TURNS]: "40",
        [ENV_MAX_BUDGET]: "10",
        [ENV_REMAINING_BUDGET]: "1",
      },
    });
    expect(
      recommendVerificationDepth({
        budget: mid,
        statedAcceptanceMet: true,
        deepenReserveBudget: 5,
      }),
    ).toBe("stated-only");
    expect(
      recommendVerificationDepth({
        budget: mid,
        statedAcceptanceMet: true,
        deepenReserveBudget: 1,
      }),
    ).toBe("stated-then-deepen");
  });

  it("parsePositiveNumber rejects blank and Infinity via env", () => {
    expect(detectHardEffortBudget({ environ: { [ENV_MAX_TURNS]: "   " } }).detected).toBe(false);
    expect(detectHardEffortBudget({ environ: { [ENV_MAX_TURNS]: "Infinity" } }).detected).toBe(
      false,
    );
  });

  it("detectHardEffortBudget() defaults environ to process.env", () => {
    const prev = process.env[ENV_MAX_TURNS];
    process.env[ENV_MAX_TURNS] = "33";
    try {
      const budget = detectHardEffortBudget();
      expect(budget.maxTurns).toBe(33);
    } finally {
      if (prev === undefined) delete process.env[ENV_MAX_TURNS];
      else process.env[ENV_MAX_TURNS] = prev;
    }
  });

  it("remaining-only env still detects hard cap", () => {
    const budget = detectHardEffortBudget({
      environ: { [ENV_REMAINING_TURNS]: "8" },
    });
    expect(budget.detected).toBe(true);
    expect(budget.posture).toBe("hard-capped");
    expect(budget.kind).toBe("max-turns");
    expect(budget.maxTurns).toBeNull();
    expect(budget.remainingTurns).toBe(8);
  });

  it("remaining-only cost env detects max-cost", () => {
    const budget = detectHardEffortBudget({
      environ: { [ENV_REMAINING_BUDGET]: "2" },
    });
    expect(budget.kind).toBe("max-cost");
    expect(budget.remainingBudget).toBe(2);
  });

  it("DEFT_HOST_EFFORT_BUDGET JSON wires host descriptor without seams", () => {
    const parsed = parseHostEffortBudgetEnv({
      [ENV_HOST_EFFORT_BUDGET]: JSON.stringify({ maxTurns: 90, hardBudget: true }),
    });
    expect(parsed).toMatchObject({ maxTurns: 90 });
    const budget = detectHardEffortBudget({
      environ: {
        [ENV_HOST_EFFORT_BUDGET]: JSON.stringify({ maxTurns: 90 }),
      },
    });
    expect(budget.maxTurns).toBe(90);
    expect(budget.sources.some((s) => s.includes("HOST_EFFORT"))).toBe(true);
  });

  it("parseHostEffortBudgetEnv fails open on bad JSON", () => {
    expect(parseHostEffortBudgetEnv({ [ENV_HOST_EFFORT_BUDGET]: "not-json" })).toBeNull();
    expect(parseHostEffortBudgetEnv({ [ENV_HOST_EFFORT_BUDGET]: "[]" })).toBeNull();
  });

  it("resolveProductionHostEffortDescriptor maps harness env into descriptor", () => {
    const desc = resolveProductionHostEffortDescriptor({
      MAX_TURNS: "64",
      AGENT_BUDGET: "9",
      [ENV_HARD_BUDGET]: "1",
    });
    expect(desc).toMatchObject({ maxTurns: 64, maxBudget: 9, hardBudget: true });
  });
});
