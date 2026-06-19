import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readDecisionEvents,
  recommendAutonomyLevel,
  resolveCapacityAllocation,
  summarizeDecisionBacklog,
  validateCapacityAllocation,
} from "./capacity-policy.js";
import { classifyRecord, computeReport, iterVbriefPlans, renderReport } from "./capacity-show.js";
import { validateStrategyOutput } from "./validate-strategy-output.js";
import { evaluate as evaluateCapacity } from "./verify-capacity.js";

const NOW = new Date("2026-06-04T12:00:00Z");
const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-vc-branch-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("validate-content branch coverage", () => {
  it("validateCapacityAllocation covers bucket edge cases", () => {
    const errors = validateCapacityAllocation({
      unit: "nope",
      enforcement: "block",
      window: 0,
      minSampleSize: -1,
      defaultEpicEstimate: 0,
      epicStalenessDays: 0,
      buckets: [
        { id: "", target: 2 },
        { id: "a", target: "x" },
      ],
      defaultBucket: "missing",
    });
    expect(errors.length).toBeGreaterThan(3);
  });

  it("validateCapacityAllocation catches duplicate bucket ids", () => {
    const errors = validateCapacityAllocation({
      window: 30,
      buckets: [
        { id: "a", target: 0.5 },
        { id: "a", target: 0.5 },
      ],
    });
    expect(errors.some((e) => e.includes("duplicates"))).toBe(true);
  });

  it("validateCapacityAllocation catches target sum drift", () => {
    const errors = validateCapacityAllocation({
      window: 30,
      buckets: [
        { id: "a", target: 0.3 },
        { id: "b", target: 0.3 },
      ],
    });
    expect(errors.some((e) => e.includes("sum to 1.0"))).toBe(true);
  });

  it("resolveCapacityAllocation returns default-on-error", () => {
    const root = tempRoot();
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: { policy: { capacityAllocation: { window: 30, buckets: [] } } },
      }),
    );
    const allocation = resolveCapacityAllocation(root);
    expect(allocation.source).toBe("default-on-error");
    expect(allocation.error).not.toBeNull();
  });

  it("classifyRecord handles epic and rework metadata", () => {
    const allocation = resolveCapacityAllocation(tempRoot());
    const plan = {
      metadata: { kind: "epic", estimatedChildren: 2, outcome: "rework" },
      references: [{ type: "x-vbrief/plan", uri: "child" }],
    };
    const decomposed = classifyRecord(plan, "pending", allocation, NOW);
    expect(decomposed.weight).toBe(0);

    const undecomposed = classifyRecord({ metadata: { kind: "epic" } }, "pending", allocation, NOW);
    expect(undecomposed.weight).toBe(allocation.defaultEpicEstimate);
  });

  it("iterVbriefPlans skips malformed files", () => {
    const root = tempRoot();
    mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
    writeFileSync(join(root, "vbrief", "pending", "bad.vbrief.json"), "not-json");
    writeFileSync(join(root, "vbrief", "pending", "note.txt"), "x");
    expect(iterVbriefPlans(join(root, "vbrief"))).toEqual([]);
  });

  it("summarizeDecisionBacklog reads audit log events", () => {
    const root = tempRoot();
    mkdirSync(join(root, "vbrief", ".audit"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", ".audit", "pending-human-decisions.jsonl"),
      `${JSON.stringify({ decision_id: "d1", status: "pending", kind: "gate" })}\n` +
        `${JSON.stringify({ decision_id: "d1", status: "resolved", timestamp: "2026-06-03T00:00:00Z", override: true })}\n`,
    );
    const backlog = summarizeDecisionBacklog(root, { now: NOW, windowDays: 30 });
    expect(backlog.pendingCount).toBe(0);
    expect(backlog.resolvedInWindow).toBe(1);
    expect(readDecisionEvents(root).length).toBe(2);
  });

  it("recommendAutonomyLevel covers advance and retreat branches", () => {
    const retreat = recommendAutonomyLevel("escalate", {
      overrideRate: 0.5,
      reworkRate: 0,
      sampleSize: 0,
    });
    expect(retreat.action).toBe("retreat");

    const advance = recommendAutonomyLevel("observe", {
      overrideRate: 0,
      reworkRate: 0,
      sampleSize: 25,
    });
    expect(advance.action).toBe("advance");
  });

  it("post-cutover full-spec consumer tolerates specification.vbrief.json", () => {
    const root = tempRoot();
    for (const d of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(root, "vbrief", d), { recursive: true });
    }
    writeFileSync(join(root, "vbrief", "specification.vbrief.json"), "{}");
    writeFileSync(join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"), "{}");
    writeFileSync(join(root, "vbrief", "completed", "2026-05-26-done.vbrief.json"), "{}");
    writeFileSync(
      join(root, "SPECIFICATION.md"),
      "<!-- Purpose: rendered specification -->\n<!-- Source of truth: vbrief/specification.vbrief.json -->\n",
    );
    expect(validateStrategyOutput(root).some((e) => e.includes("Legacy"))).toBe(false);
  });

  it("enforce balanced mix stays within tolerance", () => {
    const root = tempRoot();
    for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(root, "vbrief", folder), { recursive: true });
    }
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: {
          policy: {
            capacityAllocation: {
              unit: "vbrief-count",
              window: 30,
              enforcement: "enforce",
              minSampleSize: 2,
              defaultBucket: "debt",
              buckets: [
                { id: "debt", target: 0.4 },
                { id: "feature", target: 0.6 },
              ],
            },
          },
        },
      }),
    );
    const completedAt = "2026-06-03T12:00:00Z";
    const layout: Array<[string, number]> = [
      ["debt", 2],
      ["feature", 3],
    ];
    for (const [bucket, count] of layout) {
      for (let i = 0; i < count; i += 1) {
        writeFileSync(
          join(root, "vbrief", "completed", `${bucket}-${i}.vbrief.json`),
          JSON.stringify({
            vBRIEFInfo: { version: "0.6" },
            plan: {
              metadata: { capacityBucket: bucket, completedAt },
            },
          }),
        );
      }
    }
    const result = evaluateCapacity({ projectRoot: root, now: NOW });
    expect(result.code).toBe(0);
    expect(result.message).toContain("within target tolerance");
    const report = computeReport(root, { now: NOW });
    expect(renderReport(report)).toContain("debt");
  });
});
