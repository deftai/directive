import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recommendAutonomyLevel } from "../policy/autonomy.js";
import { CAPACITY_UNIT_COST, resolveCapacityAllocation } from "../policy/capacity.js";
import {
  bucketDeficit,
  classifyRecord,
  computeReport,
  evaluate,
  iterVbriefPlans,
  renderReport,
  runCapacityShowCli,
} from "./show.js";

const NOW = new Date("2026-06-04T12:00:00Z");
const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-cap-show-"));
  roots.push(root);
  return root;
}

function makeProject(root: string, capacity?: Record<string, unknown>): void {
  for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
    mkdirSync(join(root, "xbrief", folder), { recursive: true });
  }
  const policy: Record<string, unknown> = {
    capacityAllocation: capacity ?? {
      unit: "vbrief-count",
      window: 30,
      enforcement: "advise",
      minSampleSize: 5,
      defaultBucket: "feature",
      buckets: [
        { id: "debt", target: 0.4 },
        { id: "feature", target: 0.6 },
      ],
    },
  };
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    `${JSON.stringify(
      {
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "Capacity test",
          status: "running",
          items: [],
          policy,
        },
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8" },
  );
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("capacity show", () => {
  it("reports advisory mode below minSampleSize", () => {
    const root = tempRoot();
    makeProject(root);
    writeFileSync(
      join(root, "xbrief", "completed", "done-0.xbrief.json"),
      `${JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "done-0",
          status: "completed",
          items: [],
          metadata: {
            capacityBucket: "feature",
            completedAt: "2026-06-03T12:00:00Z",
          },
        },
      })}\n`,
      { encoding: "utf8" },
    );
    const report = computeReport(root, { now: NOW });
    expect(report.advisory_mode).toBe(true);
    expect(renderReport(report)).toContain("ADVISORY");
  });

  it("classifyRecord covers bucket, epic, rework, and cost branches", () => {
    const allocation = resolveCapacityAllocation(tempRoot());
    expect(classifyRecord({ metadata: {} }, "completed", allocation, NOW).bucket).toBe(
      "unassigned",
    );

    const defaultBucketAlloc = {
      ...allocation,
      default_bucket: "feature",
      buckets: [{ bucket_id: "feature", target: 1 }],
    };
    expect(classifyRecord({ metadata: {} }, "pending", defaultBucketAlloc, NOW).bucket).toBe(
      "feature",
    );

    const decomposed = classifyRecord(
      {
        metadata: { kind: "epic", estimatedChildren: 2, outcome: "rework", cost: true },
        references: [{ type: "x-vbrief/plan", uri: "child" }],
      },
      "completed",
      allocation,
      NOW,
    );
    expect(decomposed.weight).toBe(0);
    expect(decomposed.is_rework).toBe(true);
    expect(decomposed.cost).toBeNull();

    const epicEstimate = classifyRecord(
      { metadata: { kind: "epic", estimatedChildren: -1, cost: 3.5 } },
      "pending",
      allocation,
      NOW,
    );
    expect(epicEstimate.weight).toBe(allocation.default_epic_estimate);
    expect(epicEstimate.cost).toBe(3.5);

    const inWindow = classifyRecord(
      {
        metadata: {
          capacityBucket: "feature",
          completedAt: "2026-06-03T12:00:00Z",
        },
      },
      "completed",
      allocation,
      NOW,
    );
    expect(inWindow.in_window).toBe(true);
    expect(inWindow.completed_at_present).toBe(true);
  });

  it("iterVbriefPlans skips missing folders and malformed artifacts", () => {
    const root = tempRoot();
    mkdirSync(join(root, "xbrief", "pending"), { recursive: true });
    writeFileSync(join(root, "xbrief", "pending", "bad.xbrief.json"), "not-json");
    writeFileSync(join(root, "xbrief", "pending", "note.txt"), "x");
    writeFileSync(
      join(root, "xbrief", "pending", "2026-06-03-good.xbrief.json"),
      JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { metadata: {} } }),
    );
    expect(iterVbriefPlans(join(root, "xbrief")).length).toBe(1);
    expect(iterVbriefPlans(join(root, "missing"))).toEqual([]);
  });

  it("computeReport covers cost-unit fallback and unclassified advisory reasons", () => {
    const root = tempRoot();
    makeProject(root, {
      unit: CAPACITY_UNIT_COST,
      window: 30,
      enforcement: "advise",
      minSampleSize: 5,
      defaultBucket: "feature",
      buckets: [{ id: "feature", target: 1 }],
    });
    writeFileSync(
      join(root, "xbrief", "completed", "2026-06-03-a.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { metadata: { capacityBucket: "feature", completedAt: "2026-06-03T12:00:00Z" } },
      }),
    );
    writeFileSync(
      join(root, "xbrief", "completed", "2026-06-03-unclassified.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: { metadata: { completedAt: "2026-06-03T12:00:00Z" } },
      }),
    );
    const projectAllocation = resolveCapacityAllocation(root);
    const report = computeReport(root, {
      now: NOW,
      allocation: { ...projectAllocation, unit: CAPACITY_UNIT_COST },
    });
    expect(report.unit_effective).toBe("vbrief-count");
    expect(report.cost_fallback).toBe(true);
    expect(report.advisory_reasons.some((r) => r.includes("unclassified"))).toBe(true);
  });

  it("renderReport covers backlog, autonomy, deficit, and empty bucket table", () => {
    const root = tempRoot();
    makeProject(root);
    const report = computeReport(root, { now: NOW });
    const negativeDeficitReport = {
      ...report,
      total_backward: 10,
      buckets: [
        {
          bucket_id: "feature",
          target: 0.1,
          forward_weight: 0,
          backward_weight: 5,
          rework_weight: 0,
          cost_actual: null,
        },
      ],
      pending_by_kind: { gate: 2 },
      autonomy_enabled: true,
      autonomy: recommendAutonomyLevel("observe", {
        override_rate: 0,
        rework_rate: 0,
        sample_size: 0,
      }),
      policy_error: "bad config",
      cost_fallback: true,
      unit_requested: CAPACITY_UNIT_COST,
    };
    const rendered = renderReport(negativeDeficitReport);
    expect(rendered).toContain("by kind: gate=2");
    expect(rendered).toContain("CONFIG ERROR");
    expect(rendered).toContain("cost fallback active");
    expect(rendered).toContain("Autonomy dial");
    const [featureBucket] = negativeDeficitReport.buckets;
    expect(featureBucket).toBeDefined();
    if (!featureBucket) return;
    expect(bucketDeficit(negativeDeficitReport, featureBucket)).toBeLessThan(0);
    expect(renderReport({ ...report, buckets: [] })).toContain("no buckets configured");
  });

  it("evaluate and runCapacityShowCli cover CLI entry branches", () => {
    const root = tempRoot();
    makeProject(root);
    writeFileSync(
      join(root, "xbrief", "completed", "done-0.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          metadata: { capacityBucket: "feature", completedAt: "2026-06-03T12:00:00Z" },
        },
      }),
    );

    const fileRoot = tempRoot();
    const notDir = join(fileRoot, "file.txt");
    writeFileSync(notDir, "x");
    const [badCode, badReport, badMessage] = evaluate(notDir);
    expect(badCode).toBe(2);
    expect(badReport).toBeNull();
    expect(badMessage).toContain("not a directory");

    const [okCode, okReport] = evaluate(root, { now: NOW });
    expect(okCode).toBe(0);
    expect(okReport).not.toBeNull();

    const missingArg = runCapacityShowCli(["--project-root"]);
    expect(missingArg.exitCode).toBe(2);
    expect(missingArg.stderr).toContain("expected one argument");

    const okCli = runCapacityShowCli(["--project-root", root]);
    expect(okCli.exitCode).toBe(0);
    expect(okCli.stdout).toContain("Capacity allocation");

    const eqCli = runCapacityShowCli([`--project-root=${root}`]);
    expect(eqCli.exitCode).toBe(0);
  });
});
