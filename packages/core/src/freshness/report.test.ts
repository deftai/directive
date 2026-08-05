import { describe, expect, it } from "vitest";
import { compareFreshness } from "./compare.js";
import { defaultSurfaceFingerprints } from "./generation.js";
import { formatFreshnessReport, freshnessReportExitCode, freshnessReportToJson } from "./report.js";
import type { BoundGeneration, LiveGeneration } from "./types.js";

function live(generation: number, contentVersion: string): LiveGeneration {
  return {
    schemaVersion: 1,
    generation,
    contentVersion,
    stampedAt: "2026-08-04T00:00:00Z",
    stampedBy: "test",
    surfaces: defaultSurfaceFingerprints(contentVersion),
  };
}

function bound(generation: number, contentVersion: string): BoundGeneration {
  return {
    schemaVersion: 1,
    boundGeneration: generation,
    boundAt: "2026-08-04T00:00:00Z",
    contentVersion,
    surfaces: defaultSurfaceFingerprints(contentVersion),
  };
}

describe("freshness report formatting (#3117)", () => {
  it("formats a human report", () => {
    const text = formatFreshnessReport(compareFreshness(bound(1, "1.0.0"), live(1, "1.0.0")));
    expect(text).toContain("state              : current");
    expect(text).toContain("ready              : yes");
  });

  it("json shape includes state and surfaces", () => {
    const json = freshnessReportToJson(compareFreshness(null, live(1, "1.0.0")));
    expect(json.state).toBe("unbound");
    expect(json.ready).toBe(false);
  });

  it("exit codes map state", () => {
    expect(freshnessReportExitCode(compareFreshness(bound(1, "1.0.0"), live(1, "1.0.0")))).toBe(0);
    expect(freshnessReportExitCode(compareFreshness(null, live(1, "1.0.0")))).toBe(1);
    expect(freshnessReportExitCode(compareFreshness(bound(1, "1.0.0"), live(2, "2.0.0")))).toBe(2);
  });
});
