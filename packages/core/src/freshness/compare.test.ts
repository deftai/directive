import { describe, expect, it } from "vitest";
import { compareFreshness, MID_MISSION_SAFETY } from "./compare.js";
import { defaultSurfaceFingerprints } from "./generation.js";
import { freshnessReportExitCode } from "./report.js";
import type { BoundGeneration, LiveGeneration } from "./types.js";

function live(
  generation: number,
  contentVersion: string,
  surfaces?: LiveGeneration["surfaces"],
): LiveGeneration {
  return {
    schemaVersion: 1,
    generation,
    contentVersion,
    stampedAt: "2026-08-04T00:00:00Z",
    stampedBy: "test",
    surfaces: surfaces ?? defaultSurfaceFingerprints(contentVersion),
  };
}

function bound(
  generation: number,
  contentVersion: string,
  surfaces?: BoundGeneration["surfaces"],
): BoundGeneration {
  return {
    schemaVersion: 1,
    boundGeneration: generation,
    boundAt: "2026-08-04T00:00:00Z",
    contentVersion,
    surfaces: surfaces ?? defaultSurfaceFingerprints(contentVersion),
  };
}

describe("compareFreshness states (#3117)", () => {
  it("current when bound matches live", () => {
    const report = compareFreshness(bound(3, "1.0.0"), live(3, "1.0.0"));
    expect(report.state).toBe("current");
    expect(report.ready).toBe(true);
    expect(report.differingSurfaces).toEqual([]);
    expect(freshnessReportExitCode(report)).toBe(0);
  });

  it("stale_soft when only soft surfaces differ", () => {
    const b = bound(3, "1.0.0", {
      ...defaultSurfaceFingerprints("1.0.0"),
      docs: "1.0.0",
    });
    const l = live(3, "1.0.0", {
      ...defaultSurfaceFingerprints("1.0.0"),
      docs: "1.0.1-docs",
    });
    const report = compareFreshness(b, l);
    expect(report.state).toBe("stale_soft");
    expect(report.ready).toBe(false);
    expect(report.softDiffs).toContain("docs");
    expect(report.hardDiffs).toEqual([]);
    expect(freshnessReportExitCode(report)).toBe(1);
  });

  it("stale_hard when hard surfaces differ", () => {
    const report = compareFreshness(bound(2, "1.0.0"), live(3, "1.1.0"));
    expect(report.state).toBe("stale_hard");
    expect(report.ready).toBe(false);
    expect(report.hardDiffs.length).toBeGreaterThan(0);
    expect(report.rebindGuidance).toContain("Rebind");
    expect(report.midMissionSafety).toBe(MID_MISSION_SAFETY);
    expect(freshnessReportExitCode(report)).toBe(2);
  });

  it("stale_hard on generation mismatch with identical fingerprints", () => {
    const surfaces = defaultSurfaceFingerprints("1.0.0");
    const report = compareFreshness(bound(1, "1.0.0", surfaces), live(2, "1.0.0", surfaces));
    expect(report.state).toBe("stale_hard");
    expect(report.ready).toBe(false);
  });

  it("unbound when no session bind", () => {
    const report = compareFreshness(null, live(1, "1.0.0"));
    expect(report.state).toBe("unbound");
    expect(report.ready).toBe(false);
    expect(report.rebindGuidance).toMatch(/No session bind/i);
    expect(freshnessReportExitCode(report)).toBe(1);
  });

  it("stale_hard when live token missing", () => {
    const report = compareFreshness(bound(1, "1.0.0"), null);
    expect(report.state).toBe("stale_hard");
    expect(report.ready).toBe(false);
  });
});
