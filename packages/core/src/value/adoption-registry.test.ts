import { describe, expect, it } from "vitest";
import {
  ADOPTION_SIGNAL_CLASS,
  ADOPTION_THRESHOLDS,
  type CapabilityId,
  detectApplicableButUnused,
  detectApplicableButUnusedGated,
  evaluateApplicability,
  formatAdoptionEventName,
  isWorkTooSmallForAdoptionNudges,
  type WorkContext,
} from "./adoption-registry.js";

const ALL_CAPABILITY_IDS: CapabilityId[] = [
  "planning",
  "cost",
  "decompose",
  "swarm",
  "pre-pr",
  "debug",
  "glossary",
  "lessons",
];

function applicableContext(id: CapabilityId): WorkContext {
  const base = { usedCapabilities: [] as const };
  switch (id) {
    case "planning":
      return {
        ...base,
        filesTouched: ADOPTION_THRESHOLDS.planningMinFiles,
        distinctModuleGlobs: 1,
      };
    case "cost":
      return {
        ...base,
        filesTouched: ADOPTION_THRESHOLDS.costMinFiles,
        distinctModuleGlobs: 1,
        isBuildIntent: true,
      };
    case "decompose":
      return {
        ...base,
        filesTouched: ADOPTION_THRESHOLDS.largeMultiFileMinFiles,
        distinctModuleGlobs: ADOPTION_THRESHOLDS.largeMultiFileMinModules,
      };
    case "swarm":
      return {
        ...base,
        filesTouched: ADOPTION_THRESHOLDS.swarmMinFiles,
        distinctModuleGlobs: ADOPTION_THRESHOLDS.swarmMinModules,
      };
    case "pre-pr":
      return { ...base, filesTouched: 3, distinctModuleGlobs: 1, isPrOpening: true };
    case "debug":
      return { ...base, filesTouched: 10, distinctModuleGlobs: 3 };
    case "glossary":
      return {
        ...base,
        filesTouched: ADOPTION_THRESHOLDS.glossaryMinFiles,
        distinctModuleGlobs: 2,
      };
    case "lessons":
      return {
        ...base,
        filesTouched: ADOPTION_THRESHOLDS.lessonsMinFiles,
        distinctModuleGlobs: 2,
      };
  }
}

function ctx(partial: Partial<WorkContext> & Pick<WorkContext, "filesTouched">): WorkContext {
  return {
    distinctModuleGlobs: partial.distinctModuleGlobs ?? 1,
    usedCapabilities: partial.usedCapabilities ?? [],
    isBuildIntent: partial.isBuildIntent,
    isPrOpening: partial.isPrOpening,
    ...partial,
  };
}

describe("capability catalog (#1709-adoption-registry-a1)", () => {
  it("records each capability with heuristic metadata and usage signals", () => {
    expect(ALL_CAPABILITY_IDS).toHaveLength(8);
    for (const id of ALL_CAPABILITY_IDS) {
      const verdict = evaluateApplicability(id, applicableContext(id));
      if (id === "debug") {
        expect(verdict.applicable).toBe(false);
        continue;
      }
      expect(verdict.applicable).toBe(true);
      const signal = detectApplicableButUnused(applicableContext(id)).find(
        (entry) => entry.capabilityId === id,
      );
      expect(signal).toBeDefined();
      expect(signal?.message.length).toBeGreaterThan(0);
      expect(signal?.evidence.usageSignals).toBeDefined();
      expect((signal?.evidence.usageSignals as unknown[]).length).toBeGreaterThan(0);
    }
  });

  it("includes interview and speckit usage signals for planning", () => {
    const signal = detectApplicableButUnused(applicableContext("planning")).find(
      (entry) => entry.capabilityId === "planning",
    );
    expect(signal?.evidence.usageSignals).toEqual([
      "command:/deft:directive:run:interview",
      "command:/deft:directive:run:speckit",
    ]);
  });

  it("formats adoption event names for the ledger", () => {
    expect(formatAdoptionEventName("decompose")).toBe(`${ADOPTION_SIGNAL_CLASS}:decompose`);
  });
});

describe("applicable-but-unused detection (#1709-adoption-registry-a2)", () => {
  it("emits decompose adoption signal for large multi-file work without decompose", () => {
    const signals = detectApplicableButUnused(
      ctx({
        filesTouched: ADOPTION_THRESHOLDS.largeMultiFileMinFiles,
        distinctModuleGlobs: ADOPTION_THRESHOLDS.largeMultiFileMinModules,
      }),
    );
    const decompose = signals.find((signal) => signal.capabilityId === "decompose");
    expect(decompose).toBeDefined();
    expect(decompose?.event).toBe("adoption:decompose");
    expect(decompose?.signalClass).toBe("adoption");
    expect(decompose?.evidence.filesTouched).toBe(ADOPTION_THRESHOLDS.largeMultiFileMinFiles);
  });

  it("suppresses signals for capabilities already used", () => {
    const signals = detectApplicableButUnused(
      ctx({
        filesTouched: 6,
        distinctModuleGlobs: 2,
        usedCapabilities: ["decompose"],
      }),
    );
    expect(signals.some((signal) => signal.capabilityId === "decompose")).toBe(false);
  });

  it("emits pre-pr signal at PR-open boundary when pre-pr was skipped", () => {
    const signals = detectApplicableButUnused(
      ctx({
        filesTouched: 3,
        isPrOpening: true,
      }),
    );
    expect(signals.some((signal) => signal.capabilityId === "pre-pr")).toBe(true);
  });

  it("emits cost signal for build intent without cost phase", () => {
    const signals = detectApplicableButUnused(
      ctx({
        filesTouched: ADOPTION_THRESHOLDS.costMinFiles,
        isBuildIntent: true,
      }),
    );
    expect(signals.some((signal) => signal.capabilityId === "cost")).toBe(true);
  });
});

describe("conservative false-positive guard (#1709-adoption-registry-a3)", () => {
  it("rejects adoption nudges for small work", () => {
    const small = ctx({ filesTouched: ADOPTION_THRESHOLDS.smallWorkMaxFiles });
    expect(isWorkTooSmallForAdoptionNudges(small)).toBe(true);
    expect(detectApplicableButUnused(small)).toEqual([]);
    expect(evaluateApplicability("decompose", small).applicable).toBe(false);
  });

  it("rejects decompose for non-parallelizable single-module work", () => {
    const verdict = evaluateApplicability(
      "decompose",
      ctx({
        filesTouched: 10,
        distinctModuleGlobs: 1,
      }),
    );
    expect(verdict.applicable).toBe(false);
    expect(verdict.reason).toContain("parallelizable");
    expect(
      detectApplicableButUnused(
        ctx({
          filesTouched: 10,
          distinctModuleGlobs: 1,
        }),
      ).some((signal) => signal.capabilityId === "decompose"),
    ).toBe(false);
  });

  it("rejects swarm below module breadth threshold", () => {
    const verdict = evaluateApplicability(
      "swarm",
      ctx({
        filesTouched: ADOPTION_THRESHOLDS.swarmMinFiles,
        distinctModuleGlobs: ADOPTION_THRESHOLDS.swarmMinModules - 1,
      }),
    );
    expect(verdict.applicable).toBe(false);
  });

  it("never auto-nudges debug without an explicit failure signal", () => {
    expect(
      evaluateApplicability(
        "debug",
        ctx({
          filesTouched: 20,
          distinctModuleGlobs: 5,
        }),
      ).applicable,
    ).toBe(false);
  });
  it("suppresses planning nudges at the PR-open boundary", () => {
    expect(
      detectApplicableButUnused(
        ctx({
          filesTouched: 8,
          distinctModuleGlobs: 2,
          isPrOpening: true,
        }),
      ).some((signal) => signal.capabilityId === "planning"),
    ).toBe(false);
    expect(
      detectApplicableButUnused(
        ctx({
          filesTouched: 8,
          distinctModuleGlobs: 2,
          isPrOpening: true,
        }),
      ).some((signal) => signal.capabilityId === "pre-pr"),
    ).toBe(true);
  });
});

describe("used capability suppression", () => {
  it("reflects the usedCapabilities list via detection output", () => {
    const work = ctx({ filesTouched: 6, distinctModuleGlobs: 2, usedCapabilities: ["decompose"] });
    expect(
      detectApplicableButUnused(work).some((signal) => signal.capabilityId === "decompose"),
    ).toBe(false);
  });
});

describe("value-feedback policy gate", () => {
  it("returns no signals when value feedback is disabled", () => {
    const signals = detectApplicableButUnusedGated(
      ctx({
        filesTouched: 8,
        distinctModuleGlobs: 3,
      }),
      {
        enabled: false,
        emitEvents: false,
        sessionLine: false,
        upstreamPrompt: false,
        source: "default",
        error: null,
      },
    );
    expect(signals).toEqual([]);
  });

  it("returns signals when enabled and emitEvents path is allowed", () => {
    const signals = detectApplicableButUnusedGated(
      ctx({
        filesTouched: 8,
        distinctModuleGlobs: 3,
      }),
      {
        enabled: true,
        emitEvents: true,
        sessionLine: true,
        upstreamPrompt: false,
        source: "typed",
        error: null,
      },
    );
    expect(signals.length).toBeGreaterThan(0);
  });

  it("returns no signals when enabled but emitEvents sub-flag is off", () => {
    const signals = detectApplicableButUnusedGated(
      ctx({
        filesTouched: 8,
        distinctModuleGlobs: 3,
      }),
      {
        enabled: true,
        emitEvents: false,
        sessionLine: true,
        upstreamPrompt: false,
        source: "typed",
        error: null,
      },
    );
    expect(signals).toEqual([]);
  });
});
