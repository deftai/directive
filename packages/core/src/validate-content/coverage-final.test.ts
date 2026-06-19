import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as capacityPolicy from "./capacity-policy.js";
import {
  readDecisionEvents,
  recommendAutonomyLevel,
  resolveAutonomy,
  validateCapacityAllocation,
} from "./capacity-policy.js";
import * as capacityShow from "./capacity-show.js";
import { computeReport, renderReport } from "./capacity-show.js";
import { isDatePrefixedVbriefFilename } from "./filename.js";
import { extractLinkTargets } from "./link-parser.js";
import { evaluate as evaluateLinks } from "./validate-links.js";
import { evaluate as evaluateCapacity, runMain } from "./verify-capacity.js";

const NOW = new Date("2026-06-04T12:00:00Z");
const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-vc-final-"));
  roots.push(root);
  return root;
}

function writeProject(root: string, capacity: Record<string, unknown>): void {
  for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
    mkdirSync(join(root, "vbrief", folder), { recursive: true });
  }
  writeFileSync(
    join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({
      vBRIEFInfo: { version: "0.6" },
      plan: { policy: { capacityAllocation: capacity } },
    }),
  );
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("validate-content final coverage", () => {
  it("renders cost fallback and pending nudge branches", () => {
    const root = tempRoot();
    writeProject(root, {
      unit: "cost",
      window: 30,
      enforcement: "advise",
      minSampleSize: 1,
      defaultBucket: "feature",
      buckets: [{ id: "feature", target: 1 }],
    });
    const completedAt = "2026-06-03T12:00:00Z";
    writeFileSync(
      join(root, "vbrief", "completed", "2026-06-01-f.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: {
          metadata: { capacityBucket: "feature", completedAt },
        },
      }),
    );
    mkdirSync(join(root, "vbrief", ".audit"), { recursive: true });
    const lines = Array.from({ length: 6 }, (_, i) =>
      JSON.stringify({ decision_id: `d${i}`, status: "pending", kind: "gate" }),
    );
    writeFileSync(
      join(root, "vbrief", ".audit", "pending-human-decisions.jsonl"),
      `${lines.join("\n")}\n`,
    );
    const report = computeReport(root, { now: NOW });
    const text = renderReport(report);
    expect(text).toContain("cost fallback active");
    expect(text).toContain("[TIER-1] pending human-clearance backlog");
    expect(readDecisionEvents(root).length).toBe(6);
  });

  it("covers enforce below-sample and quiet main paths", () => {
    const root = tempRoot();
    writeProject(root, {
      unit: "vbrief-count",
      window: 30,
      enforcement: "enforce",
      minSampleSize: 10,
      defaultBucket: "feature",
      buckets: [
        { id: "debt", target: 0.4 },
        { id: "feature", target: 0.6 },
      ],
    });
    const completedAt = "2026-06-03T12:00:00Z";
    writeFileSync(
      join(root, "vbrief", "completed", "f0.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: { metadata: { capacityBucket: "feature", completedAt } },
      }),
    );
    const below = evaluateCapacity({ projectRoot: root, now: NOW });
    expect(below.code).toBe(0);
    expect(below.message).toContain("below minSampleSize");

    const quiet = runMain({ projectRoot: root, now: NOW, quiet: true });
    expect(quiet.stream).toBe("none");
  });

  it("covers link parser and filename edge branches", () => {
    expect(extractLinkTargets("no links")).toEqual([]);
    expect(extractLinkTargets("[open only")).toEqual([]);
    expect(isDatePrefixedVbriefFilename("2026-01-01.vbrief.json")).toBe(false);
    expect(isDatePrefixedVbriefFilename("2026-01-01-.vbrief.json")).toBe(false);
    expect(isDatePrefixedVbriefFilename("2026-01-01-A.vbrief.json")).toBe(false);
  });

  it("covers validate-links read failures gracefully", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, "skip.md"), "See [x](y.md)\n");
    expect(evaluateLinks({ cwd: root, strict: false }).code).toBe(0);
  });

  it("covers autonomy advance-at-max and disabled policy branches", () => {
    const atMax = recommendAutonomyLevel("execute", {
      overrideRate: 0,
      reworkRate: 0,
      sampleSize: 25,
    });
    expect(atMax.action).toBe("hold");
    expect(atMax.rationale).toContain("most permissive");

    const observeRetreat = recommendAutonomyLevel("observe", {
      overrideRate: 0.9,
      reworkRate: 0,
      sampleSize: 0,
      p0Reversal: true,
    });
    expect(observeRetreat.action).toBe("hold");
    expect(observeRetreat.rationale).toContain("most conservative");
  });

  it("covers verify-capacity unconfigured enforce branch via stubs", () => {
    const allocation = {
      unit: "vbrief-count",
      windowDays: 30,
      enforcement: "enforce",
      minSampleSize: 2,
      buckets: [],
      defaultBucket: "",
      defaultEpicEstimate: 3,
      epicStalenessDays: 30,
      source: "typed" as const,
      error: null,
      configured: false,
    };
    vi.spyOn(capacityPolicy, "resolveCapacityAllocation").mockReturnValue(allocation);
    vi.spyOn(capacityShow, "computeReport").mockReturnValue({
      configured: false,
      source: "typed",
      unitRequested: "vbrief-count",
      unitEffective: "vbrief-count",
      costFallback: false,
      costFallbackReason: null,
      windowDays: 30,
      minSampleSize: 2,
      classifiedCompletions: 0,
      unclassifiedCompletions: 0,
      advisoryMode: true,
      advisoryReasons: [],
      buckets: [],
      totalForward: 0,
      totalBackward: 0,
      policyError: null,
      pendingDecisions: 0,
      pendingDecisionsThreshold: 5,
      pendingByKind: {},
      pendingNudge: "",
      autonomyEnabled: false,
      autonomy: null,
    });
    vi.spyOn(capacityShow, "renderReport").mockReturnValue("rendered");
    const result = evaluateCapacity({ projectRoot: tempRoot() });
    expect(result.message).toContain("no capacityAllocation buckets configured");
    vi.restoreAllMocks();
  });

  it("covers capacity policy validation and autonomy disabled render", () => {
    expect(validateCapacityAllocation(null)).toEqual([]);
    const root = tempRoot();
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: { policy: { autonomy: { enabled: false } } },
      }),
    );
    expect(resolveAutonomy(root).enabled).toBe(false);
    const report = computeReport(root, { now: NOW });
    expect(renderReport(report)).not.toContain("Autonomy dial");
  });

  it("covers partial cost coverage fallback branch", () => {
    const root = tempRoot();
    writeProject(root, {
      unit: "cost",
      window: 30,
      enforcement: "advise",
      minSampleSize: 1,
      defaultBucket: "feature",
      buckets: [{ id: "feature", target: 1 }],
    });
    const completedAt = "2026-06-03T12:00:00Z";
    const payloads = [{ cost: 1 }, {}, {}];
    for (const [i, meta] of payloads.entries()) {
      writeFileSync(
        join(root, "vbrief", "completed", `2026-06-0${i + 1}-c.vbrief.json`),
        JSON.stringify({
          vBRIEFInfo: { version: "0.6" },
          plan: { metadata: { capacityBucket: "feature", completedAt, ...meta } },
        }),
      );
    }
    const text = renderReport(computeReport(root, { now: NOW }));
    expect(text).toContain("cost fallback active");
    expect(text).toContain("Note: cost overlay");
  });
});
