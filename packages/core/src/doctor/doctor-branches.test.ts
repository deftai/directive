import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decideThrottle, formatIsoZ, readState, renderDoctorStatusLine } from "./doctor-state.js";

describe("doctor branch coverage residual (#2630)", () => {
  it("covers throttle skip reasons and status rendering", () => {
    const dirtySkip = decideThrottle(
      {
        lastRunAt: new Date("2026-01-01T12:00:00Z"),
        lastExitCode: 1,
        lastFindingCount: 2,
        lastErrorCount: 1,
      },
      new Date("2026-01-01T12:30:00Z"),
    );
    expect(dirtySkip.skip).toBe(true);
    expect(renderDoctorStatusLine(dirtySkip)).toContain("UNRESOLVED");

    const allow = decideThrottle(
      {
        lastRunAt: new Date("2020-01-01T00:00:00Z"),
        lastExitCode: 0,
        lastFindingCount: 0,
        lastErrorCount: 0,
      },
      new Date("2030-01-01T00:00:00Z"),
    );
    expect(allow.skip).toBe(false);
    expect(formatIsoZ(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01T00:00:00Z");
  });

  it("readState returns null for missing cache dir", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-branch-"));
    try {
      expect(readState(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
