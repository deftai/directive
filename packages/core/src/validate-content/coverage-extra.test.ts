import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pendingDecisionsNudgeLine,
  readDecisionEvents,
  recommendAutonomyLevel,
  resolveAutonomy,
  resolveCapacityAllocation,
  summarizeDecisionBacklog,
  validateCapacityAllocation,
} from "./capacity-policy.js";
import { bucketDeficit, classifyRecord, computeReport, renderReport } from "./capacity-show.js";
import { isDatePrefixedVbriefFilename } from "./filename.js";
import { evaluate as evaluateLinks } from "./validate-links.js";
import { evaluate as evaluateCapacity, runMain } from "./verify-capacity.js";

const NOW = new Date("2026-06-04T12:00:00Z");
const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-vc-extra-"));
  roots.push(root);
  return root;
}

function writeProject(
  root: string,
  capacity: Record<string, unknown>,
  autonomy?: Record<string, unknown>,
): void {
  mkdirSync(join(root, "vbrief"), { recursive: true });
  const policy: Record<string, unknown> = { capacityAllocation: capacity };
  if (autonomy) policy.autonomy = autonomy;
  writeFileSync(
    join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan: { policy } }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("validate-content extra branch coverage", () => {
  it("filename validator rejects malformed date and slug segments", () => {
    expect(isDatePrefixedVbriefFilename("2026/05/26-bad.vbrief.json")).toBe(false);
    expect(isDatePrefixedVbriefFilename("2026-05-26-.vbrief.json")).toBe(false);
    expect(isDatePrefixedVbriefFilename("2026-05-26-Bad.vbrief.json")).toBe(false);
    expect(isDatePrefixedVbriefFilename("2026-05-26-foo-.vbrief.json")).toBe(false);
    expect(isDatePrefixedVbriefFilename("2026-05-26-foo--bar.vbrief.json")).toBe(false);
    expect(isDatePrefixedVbriefFilename("short.vbrief.json")).toBe(false);
  });

  it("validate-links truncates long broken-link reports and honors strict env", () => {
    const root = tempRoot();
    const lines = Array.from({ length: 55 }, (_, i) => `[x${i}](missing-${i}.md)`).join(" ");
    writeFileSync(join(root, "README.md"), `${lines}\n`);
    const warn = evaluateLinks({ cwd: root });
    expect(warn.message).toContain("... and 5 more");

    const prev = process.env.LINK_CHECK_STRICT;
    process.env.LINK_CHECK_STRICT = "1";
    const strict = evaluateLinks({ cwd: root });
    process.env.LINK_CHECK_STRICT = prev;
    expect(strict.code).toBe(1);
    expect(strict.message).toContain("errors");
  });

  it("validate-links skips unreadable markdown files", () => {
    const root = tempRoot();
    mkdirSync(join(root, "locked"), { recursive: true });
    const locked = join(root, "locked", "secret.md");
    writeFileSync(locked, "[x](nope.md)\n");
    chmodSync(locked, 0o000);
    try {
      expect(evaluateLinks({ cwd: root, strict: true }).code).toBe(0);
    } finally {
      chmodSync(locked, 0o644);
    }
  });

  it("verify-capacity handles missing roots and quiet success", () => {
    const missing = evaluateCapacity({ projectRoot: join(tmpdir(), "deft-vc-missing-xyz") });
    expect(missing.code).toBe(2);
    expect(missing.stream).toBe("stderr");

    const root = tempRoot();
    writeFileSync(join(root, "not-a-dir.txt"), "x");
    const fileRoot = evaluateCapacity({ projectRoot: join(root, "not-a-dir.txt") });
    expect(fileRoot.code).toBe(2);

    mkdirSync(join(root, "vbrief", "completed"), { recursive: true });
    writeProject(root, {
      unit: "vbrief-count",
      window: 30,
      enforcement: "advise",
      minSampleSize: 1,
      defaultBucket: "feature",
      buckets: [{ id: "feature", target: 1 }],
    });
    writeFileSync(
      join(root, "vbrief", "completed", "2026-06-03-a.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: { metadata: { capacityBucket: "feature", completedAt: "2026-06-03T12:00:00Z" } },
      }),
    );
    const quiet = runMain({ projectRoot: root, now: NOW, quiet: true });
    expect(quiet.code).toBe(0);
    expect(quiet.message).toBe("");
  });

  it("verify-capacity reports enforce deficit", () => {
    const root = tempRoot();
    for (const folder of ["pending", "active", "completed"]) {
      mkdirSync(join(root, "vbrief", folder), { recursive: true });
    }
    writeProject(root, {
      unit: "vbrief-count",
      window: 30,
      enforcement: "enforce",
      minSampleSize: 1,
      defaultBucket: "feature",
      buckets: [
        { id: "debt", target: 0.9 },
        { id: "feature", target: 0.1 },
      ],
    });
    const completedAt = "2026-06-03T12:00:00Z";
    for (let i = 0; i < 10; i += 1) {
      writeFileSync(
        join(root, "vbrief", "completed", `2026-06-03-f${i}.vbrief.json`),
        JSON.stringify({
          vBRIEFInfo: { version: "0.6" },
          plan: { metadata: { capacityBucket: "feature", completedAt } },
        }),
      );
    }
    const result = evaluateCapacity({ projectRoot: root, now: NOW });
    expect(result.code).toBe(1);
    expect(result.message).toContain("DEFICIT");
  });

  it("capacity-policy autonomy and backlog edge branches", () => {
    const root = tempRoot();
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: {
          policy: {
            autonomy: {
              enabled: true,
              defaultLevel: "observe",
              gates: { gateA: "escalate", gateB: 42 },
            },
          },
        },
      }),
    );
    const autonomy = resolveAutonomy(root);
    expect(autonomy.gateLevels.gateA).toBe("escalate");
    expect(autonomy.gateLevels.gateB).toBeUndefined();

    mkdirSync(join(root, "vbrief", ".audit"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", ".audit", "pending-human-decisions.jsonl"),
      "not-json\n" +
        `${JSON.stringify({ status: "pending" })}\n` +
        `${JSON.stringify({ decision_id: "d1", status: "resolved", timestamp: "bad", override: true })}\n` +
        `${JSON.stringify({ decision_id: "d2", status: "resolved", timestamp: "2099-01-01T00:00:00Z" })}\n` +
        `${JSON.stringify({ decision_id: "d3", status: "pending", kind: "gate" })}\n`,
    );
    expect(readDecisionEvents(root).length).toBe(3);
    const backlog = summarizeDecisionBacklog(root, { now: NOW, windowDays: 30 });
    expect(backlog.pendingCount).toBe(1);
    expect(backlog.resolvedInWindow).toBe(0);

    const invalidLevel = recommendAutonomyLevel("bogus", {
      overrideRate: 0.6,
      reworkRate: 0,
      sampleSize: 0,
      policy: { ...autonomy, defaultLevel: "escalate" },
    });
    expect(invalidLevel.action).toBe("retreat");

    expect(pendingDecisionsNudgeLine(3, 5)).toBe("");
    expect(pendingDecisionsNudgeLine(6, 5)).toContain("TIER-1");

    expect(
      validateCapacityAllocation({
        window: 30,
        buckets: [null, { id: "a", target: 0.5 }],
        defaultBucket: 42,
      }).length,
    ).toBeGreaterThan(0);
  });

  it("capacity-show classification, render, and advisory branches", () => {
    const allocation = resolveCapacityAllocation(tempRoot());
    const unassigned = classifyRecord({ metadata: {} }, "completed", allocation, NOW);
    expect(unassigned.bucket).toBe("unassigned");

    const defaultBucketAlloc = {
      ...allocation,
      defaultBucket: "feature",
      buckets: [{ bucketId: "feature", target: 1 }],
    };
    const defaulted = classifyRecord({ metadata: {} }, "pending", defaultBucketAlloc, NOW);
    expect(defaulted.bucket).toBe("feature");

    const epicWeight = classifyRecord(
      { metadata: { kind: "epic", estimatedChildren: -1 } },
      "pending",
      allocation,
      NOW,
    );
    expect(epicWeight.weight).toBe(allocation.defaultEpicEstimate);

    const root = tempRoot();
    for (const folder of ["pending", "completed"]) {
      mkdirSync(join(root, "vbrief", folder), { recursive: true });
    }
    writeProject(root, {
      unit: "vbrief-count",
      window: 30,
      enforcement: "advise",
      minSampleSize: 5,
      defaultBucket: "feature",
      buckets: [{ id: "feature", target: 1 }],
    });
    writeFileSync(
      join(root, "vbrief", "completed", "2026-06-03-a.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: { metadata: { completedAt: "2026-06-03T12:00:00Z" } },
      }),
    );
    const projectAllocation = resolveCapacityAllocation(root);
    const report = computeReport(root, {
      now: NOW,
      allocation: { ...projectAllocation, unit: "bogus-unit" },
    });
    expect(report.unitEffective).toBe("vbrief-count");
    expect(report.advisoryReasons.some((r) => r.includes("unclassified"))).toBe(true);

    const negativeDeficitReport = {
      ...report,
      totalBackward: 10,
      buckets: [
        {
          bucketId: "feature",
          target: 0.1,
          forwardWeight: 0,
          backwardWeight: 5,
          reworkWeight: 0,
          costActual: null,
        },
      ],
      pendingByKind: { gate: 2 },
      autonomyEnabled: true,
      autonomy: recommendAutonomyLevel("observe", {
        overrideRate: 0,
        reworkRate: 0,
        sampleSize: 0,
      }),
    };
    const rendered = renderReport(negativeDeficitReport);
    expect(rendered).toContain("by kind: gate=2");
    expect(rendered).toContain("-");
    const [featureBucket] = negativeDeficitReport.buckets;
    expect(featureBucket).toBeDefined();
    if (!featureBucket) return;
    expect(bucketDeficit(negativeDeficitReport, featureBucket)).toBeLessThan(0);

    const empty = renderReport({ ...report, buckets: [] });
    expect(empty).toContain("no buckets configured");
  });
});
