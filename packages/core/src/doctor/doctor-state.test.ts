import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DOCTOR_DIRTY_REPROBE_HINT,
  DOCTOR_HARD_ERROR_NOTE,
  decideThrottle,
  dirtyDoctorHint,
  formatIsoZ,
  readState,
  renderDoctorStatusLine,
  statePath,
  writeState,
} from "./doctor-state.js";
import { cmdDoctor } from "./main.js";

const REMEMBERED_CLEAN = {
  lastRunAt: new Date(),
  lastExitCode: 0,
  lastFindingCount: 0,
  lastErrorCount: 0,
} as const;

function captureDoctor(
  args: readonly string[],
  seams: Parameters<typeof cmdDoctor>[1] = {},
): { code: number; output: string } {
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    return { code: cmdDoctor(args, seams), output: lines.join("") };
  } finally {
    process.stdout.write = orig;
  }
}

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
    process.env.DEFT_DOCTOR_STATE_PATH = "~/doctor-state.json";
    expect(statePath("/proj")).toBe(join(homedir(), "doctor-state.json"));
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
    expect(renderDoctorStatusLine(clean)).toContain("clean");
  });

  it("decideThrottle does not treat warning-only as dirty (#3379 / #4673)", () => {
    const now = new Date("2026-01-01T05:00:00Z");
    const decision = decideThrottle(
      {
        lastRunAt: new Date("2026-01-01T00:00:00Z"),
        lastExitCode: 0,
        lastFindingCount: 1,
        lastErrorCount: 0,
      },
      now,
    );
    expect(decision.dirty).toBe(false);
    expect(decision.skip).toBe(true);
  });

  it("renderDoctorStatusLine does not bill a warning-only skip as clean (Tester 1 / #4673)", () => {
    const now = new Date("2026-01-01T01:00:00Z");
    const warningOnly = decideThrottle(
      {
        lastRunAt: new Date("2026-01-01T00:00:00Z"),
        lastExitCode: 0,
        lastFindingCount: 1,
        lastErrorCount: 0,
      },
      now,
    );
    expect(warningOnly.skip).toBe(true);
    expect(warningOnly.dirty).toBe(false);
    const line = renderDoctorStatusLine(warningOnly, now);
    expect(line).not.toMatch(/\bclean\b/);
    expect(line).toContain("1 warning");
    expect(line).toContain("advisory");
    expect(line).toContain("throttle-skipped");
    expect(line).toContain("--full forces");
    expect(line).toContain("next eligible");
    const twoWarns = decideThrottle(
      {
        lastRunAt: new Date("2026-01-01T00:00:00Z"),
        lastExitCode: 0,
        lastFindingCount: 2,
        lastErrorCount: 0,
      },
      now,
    );
    expect(renderDoctorStatusLine(twoWarns, now)).toContain("2 warnings");
    expect(renderDoctorStatusLine(twoWarns, now)).not.toMatch(/\bclean\b/);
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
    expect(line).toContain(DOCTOR_HARD_ERROR_NOTE);
    expect(line).toContain(DOCTOR_DIRTY_REPROBE_HINT);
    expect(line).not.toContain("address findings");
    expect(dirtyDoctorHint()).toBe(`${DOCTOR_HARD_ERROR_NOTE}; ${DOCTOR_DIRTY_REPROBE_HINT}`);
    expect(dirtyDoctorHint()).not.toContain("address findings");
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

  it("throttle-skip falls through when .deft/core is gone (#4723)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-missing-core-"));
    try {
      const { code, output } = captureDoctor(["--project-root", root], {
        readState: () => REMEMBERED_CLEAN,
        now: () => new Date(),
        whichFn: () => "/bin/x",
        engineProbe: () => ({ reachable: false, version: null }),
      });
      expect(output).not.toMatch(/\[doctor\] ran/);
      expect(output).not.toContain("throttle-skipped");
      expect(output).not.toMatch(/\bclean\b/);
      expect(output).toContain("Checking system dependencies");
      expect(code).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throttle-skip json is not throttle-skipped when .deft/core is gone (#4723)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-missing-core-json-"));
    try {
      const { output } = captureDoctor(["--json", "--project-root", root], {
        readState: () => REMEMBERED_CLEAN,
        now: () => new Date(),
        whichFn: () => "/bin/x",
        engineProbe: () => ({ reachable: false, version: null }),
      });
      expect(output).not.toContain('"status": "throttle-skipped"');
      expect(output).toContain('"status": "completed"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throttle-skip still fires when .deft/core is present (#4723)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-doc-has-core-"));
    mkdirSync(join(root, ".deft", "core"), { recursive: true });
    try {
      const { code, output } = captureDoctor(["--project-root", root], {
        readState: () => REMEMBERED_CLEAN,
        now: () => new Date(),
        whichFn: () => "/bin/x",
        engineProbe: () => ({ reachable: false, version: null }),
      });
      expect(code).toBe(0);
      expect(output).toContain("[doctor] ran");
      expect(output).toContain("clean");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
