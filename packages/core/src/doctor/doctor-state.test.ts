import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decideThrottle,
  formatIsoZ,
  readState,
  renderDoctorStatusLine,
  statePath,
  writeState,
} from "./doctor-state.js";

describe("doctor-state", () => {
  it("statePath honours env override", () => {
    const prev = process.env.DEFT_DOCTOR_STATE_PATH;
    process.env.DEFT_DOCTOR_STATE_PATH = "/tmp/custom.json";
    expect(statePath("/proj")).toBe("/tmp/custom.json");
    if (prev === undefined) {
      delete process.env.DEFT_DOCTOR_STATE_PATH;
    } else {
      process.env.DEFT_DOCTOR_STATE_PATH = prev;
    }
  });

  it("statePath expands tilde override", () => {
    const prev = process.env.DEFT_DOCTOR_STATE_PATH;
    const home = process.env.HOME ?? "/home/test";
    process.env.DEFT_DOCTOR_STATE_PATH = "~/doctor-state.json";
    expect(statePath("/proj")).toBe(`${home}/doctor-state.json`);
    if (prev === undefined) {
      delete process.env.DEFT_DOCTOR_STATE_PATH;
    } else {
      process.env.DEFT_DOCTOR_STATE_PATH = prev;
    }
  });

  it("decideThrottle skips within clean window", () => {
    const now = new Date("2026-01-02T00:00:00Z");
    const decision = decideThrottle(
      {
        lastRunAt: new Date("2026-01-01T12:00:00Z"),
        lastExitCode: 0,
        lastFindingCount: 0,
        lastErrorCount: 0,
      },
      now,
    );
    expect(decision.skip).toBe(true);
    expect(decision.dirty).toBe(false);
  });

  it("decideThrottle uses dirty window", () => {
    const now = new Date("2026-01-01T13:00:00Z");
    const decision = decideThrottle(
      {
        lastRunAt: new Date("2026-01-01T12:00:00Z"),
        lastExitCode: 1,
        lastFindingCount: 2,
        lastErrorCount: 1,
      },
      now,
    );
    expect(decision.skip).toBe(true);
    expect(decision.dirty).toBe(true);
  });

  it("renderDoctorStatusLine covers dirty and clean branches", () => {
    const dirty = decideThrottle(
      {
        lastRunAt: new Date("2026-01-01T00:00:00Z"),
        lastExitCode: 1,
        lastFindingCount: 2,
        lastErrorCount: 1,
      },
      new Date("2026-01-01T12:00:00Z"),
    );
    expect(renderDoctorStatusLine(dirty)).toContain("UNRESOLVED");
    const clean = decideThrottle(
      {
        lastRunAt: new Date("2026-01-01T00:00:00Z"),
        lastExitCode: 0,
        lastFindingCount: 0,
        lastErrorCount: 0,
      },
      new Date("2026-01-01T12:00:00Z"),
    );
    expect(renderDoctorStatusLine(clean)).toContain("next eligible");
  });

  it("renderDoctorStatusLine uses singular error phrasing", () => {
    const dirty = decideThrottle(
      {
        lastRunAt: new Date("2026-01-01T00:00:00Z"),
        lastExitCode: 1,
        lastFindingCount: 1,
        lastErrorCount: 1,
      },
      new Date("2026-01-01T12:00:00Z"),
    );
    const line = renderDoctorStatusLine(dirty);
    expect(line).toContain("1 error");
    expect(line).not.toContain("1 errors");
  });

  it("readState returns null for corrupt json", () => {
    expect(readState("/tmp", () => "{bad")).toBeNull();
  });

  it("readState parses optional numeric fields", () => {
    const state = readState("/tmp", () => JSON.stringify({ last_run_at: "2026-01-01T00:00:00Z" }));
    expect(state?.lastExitCode).toBe(0);
    expect(state?.lastFindingCount).toBe(0);
    expect(state?.lastErrorCount).toBe(0);
  });

  it("readState rejects invalid iso timestamp", () => {
    expect(readState("/tmp", () => JSON.stringify({ last_run_at: "not-a-date" }))).toBeNull();
  });

  it("writeState persists on success", () => {
    const path = writeState(process.cwd(), {
      exitCode: 0,
      findingCount: 0,
      errorCount: 0,
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect(path).toContain("doctor-state.json");
  });

  it("doctor-state read/write roundtrip", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-state-"));
    try {
      writeState(root, { exitCode: 1, findingCount: 2, errorCount: 1 });
      const state = readState(root);
      expect(state?.lastExitCode).toBe(1);
      expect(decideThrottle(null).skip).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("formatIsoZ handles null", () => {
    expect(formatIsoZ(null)).toBe("");
  });
});
