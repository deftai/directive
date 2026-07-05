import { describe, expect, it } from "vitest";
import {
  ADOPTION_SIGNAL_CLASS,
  ADOPTION_THRESHOLDS,
  type CapabilityId,
  detectApplicableButUnused,
  detectApplicableButUnusedGated,
  evaluateApplicability,
  formatAdoptionEventName,
  getCapability,
  isCapabilityUsed,
  isWorkTooSmallForAdoptionNudges,
  listCapabilities,
  type WorkContext,
} from "./adoption-registry.js";

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
  it("records each capability with heuristic metadata and usage signal", () => {
    const catalog = listCapabilities();
    const ids = catalog.map((entry) => entry.id);
    const expected: CapabilityId[] = [
      "planning",
      "cost",
      "decompose",
      "swarm",
      "pre-pr",
      "debug",
      "glossary",
      "lessons",
    ];
    expect(ids).toEqual(expected);
    for (const entry of catalog) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.usageSignals.length).toBeGreaterThan(0);
      expect(entry.nudgeHint.length).toBeGreaterThan(0);
      expect(getCapability(entry.id)).toEqual(entry);
    }
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
});

describe("isCapabilityUsed", () => {
  it("reflects the usedCapabilities list", () => {
    const work = ctx({ filesTouched: 1, usedCapabilities: ["planning", "lessons"] });
    expect(isCapabilityUsed("planning", work)).toBe(true);
    expect(isCapabilityUsed("decompose", work)).toBe(false);
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
