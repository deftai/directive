import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeReport, renderReport } from "./show.js";

function makeProject(root: string): void {
  for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
    mkdirSync(join(root, "vbrief", folder), { recursive: true });
  }
  writeFileSync(
    join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
    `${JSON.stringify(
      {
        vBRIEFInfo: { version: "0.6" },
        plan: {
          title: "Capacity test",
          status: "running",
          items: [],
          policy: {
            capacityAllocation: {
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
          },
        },
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8" },
  );
}

describe("capacity show", () => {
  it("reports advisory mode below minSampleSize", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cap-show-"));
    makeProject(root);
    const now = new Date("2026-06-04T12:00:00.000Z");
    writeFileSync(
      join(root, "vbrief", "completed", "done-0.vbrief.json"),
      `${JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
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
    const report = computeReport(root, { now });
    expect(report.advisory_mode).toBe(true);
    expect(renderReport(report)).toContain("ADVISORY");
  });
});
