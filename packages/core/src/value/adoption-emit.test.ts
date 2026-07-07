import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearRegistryCache, DEFAULT_EVENT_LOG, readEvents } from "../lifecycle/events.js";
import {
  buildWorkContextFromGit,
  probeAdoptionAtWorkBoundary,
  recordAdoptionSignalsFromWorkContext,
} from "./adoption-emit.js";
import { ADOPTION_THRESHOLDS } from "./adoption-registry.js";

const temps: string[] = [];

afterEach(() => {
  clearRegistryCache();
  for (const root of temps.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeRepo(valueFeedback?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "deft-adoption-emit-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "T",
        status: "running",
        items: [],
        ...(valueFeedback !== undefined ? { policy: { valueFeedback } } : {}),
      },
    }),
    "utf8",
  );
  return root;
}

function logPath(root: string): string {
  return join(root, ".deft-cache", "events.jsonl");
}

function readAdoptionEvents(_root: string, log: string) {
  return readEvents(log).filter((record) => record.event === "adoption:unused-capability");
}

describe("buildWorkContextFromGit", () => {
  it("returns zero counts when git is unavailable", () => {
    const root = makeRepo();
    expect(buildWorkContextFromGit(root)).toEqual({
      filesTouched: 0,
      distinctModuleGlobs: 0,
      usedCapabilities: [],
    });
  });
});

describe("recordAdoptionSignalsFromWorkContext (#2339)", () => {
  const enabledPolicy = {
    enabled: true,
    emitEvents: true,
    sessionLine: true,
    upstreamPrompt: false,
    source: "typed" as const,
    error: null,
  };

  it("records adoption signals when value feedback emitEvents is enabled", () => {
    const root = makeRepo({ enabled: true, emitEvents: true });
    const log = logPath(root);
    const recorded = recordAdoptionSignalsFromWorkContext(
      root,
      {
        filesTouched: ADOPTION_THRESHOLDS.largeMultiFileMinFiles,
        distinctModuleGlobs: ADOPTION_THRESHOLDS.largeMultiFileMinModules,
        usedCapabilities: [],
      },
      { logPath: log, policyOverride: enabledPolicy },
    );
    expect(recorded).toBeGreaterThan(0);
    const entries = readAdoptionEvents(root, log);
    expect(entries.length).toBe(recorded);
    expect(entries[0]?.payload.signal_class).toBe("adoption");
    expect(entries[0]?.payload.capability).toBeDefined();
  });

  it("stays silent when value feedback is disabled", () => {
    const root = makeRepo();
    const log = logPath(root);
    const recorded = recordAdoptionSignalsFromWorkContext(
      root,
      {
        filesTouched: 8,
        distinctModuleGlobs: 3,
        usedCapabilities: [],
      },
      { logPath: log },
    );
    expect(recorded).toBe(0);
    expect(existsSync(log)).toBe(false);
  });

  it("records pre-pr adoption at PR-open boundary via probeAdoptionAtWorkBoundary", () => {
    const root = makeRepo({ enabled: true, emitEvents: true });
    const log = logPath(root);
    const recorded = probeAdoptionAtWorkBoundary(root, {
      logPath: log,
      policyOverride: enabledPolicy,
      workContext: {
        filesTouched: 3,
        distinctModuleGlobs: 1,
        usedCapabilities: [],
        isPrOpening: true,
      },
    });
    expect(recorded).toBe(1);
    const entries = readAdoptionEvents(root, log);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.payload.capability).toBe("pre-pr");
  });
});

describe("ledger default path", () => {
  it("uses DEFAULT_EVENT_LOG relative to project root", () => {
    const root = makeRepo({ enabled: true, emitEvents: true });
    recordAdoptionSignalsFromWorkContext(
      root,
      {
        filesTouched: 8,
        distinctModuleGlobs: 3,
        usedCapabilities: [],
      },
      {
        policyOverride: {
          enabled: true,
          emitEvents: true,
          sessionLine: true,
          upstreamPrompt: false,
          source: "typed",
          error: null,
        },
      },
    );
    expect(existsSync(join(root, DEFAULT_EVENT_LOG))).toBe(true);
  });
});
