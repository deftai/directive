import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACTIVE_VBRIEF_PREFIX,
  computeResumeSignal,
  detectLatestActiveVbrief,
  newRitualStatePayload,
  readSentinel,
  ritualStep,
  SCHEMA_VERSION,
  writeSentinel,
} from "./ritual-sentinel.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  temps.length = 0;
});

function tmpRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temps.push(root);
  return root;
}

function writeSentinelFile(root: string, payload: unknown): void {
  mkdirSync(join(root, ".deft"), { recursive: true });
  writeFileSync(join(root, ".deft", "last-session.json"), JSON.stringify(payload), "utf8");
}

describe("ritualStep / newRitualStatePayload branch coverage", () => {
  it("includes optional fields only when present", () => {
    const full = ritualStep({
      ok: true,
      ts: new Date("2026-06-09T00:00:00Z"),
      deferredReason: "later",
      exitCode: 0,
      message: "hi",
      command: ["a", "b"],
    });
    expect(full.deferred_reason).toBe("later");
    expect(full.exit_code).toBe(0);
    expect(full.message).toBe("hi");
    expect(full.command).toEqual(["a", "b"]);

    const minimal = ritualStep({ ok: false });
    expect(minimal.deferred_reason).toBeUndefined();
    expect(minimal.exit_code).toBeUndefined();
    expect(minimal.message).toBeUndefined();
    expect(minimal.command).toBeUndefined();
  });

  it("defaults missing steps to empty objects", () => {
    const payload = newRitualStatePayload({
      sessionId: "s",
      gitHead: "h",
      worktreePath: "w",
    });
    expect(payload.quick_steps).toEqual({});
    expect(payload.gated_steps).toEqual({});
  });
});

describe("readSentinel branch coverage", () => {
  it("returns null when the file is missing", () => {
    expect(readSentinel(tmpRoot("sent-missing-"))).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    const root = tmpRoot("sent-badjson-");
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(join(root, ".deft", "last-session.json"), "{", "utf8");
    expect(readSentinel(root)).toBeNull();
  });

  it("returns null for non-object, wrong schema, and missing fields", () => {
    const cases: unknown[] = [
      [1, 2, 3],
      { schemaVersion: 999 },
      { schemaVersion: SCHEMA_VERSION, timestamp: "not-a-date" },
      {
        schemaVersion: SCHEMA_VERSION,
        timestamp: "2026-06-09T00:00:00Z",
        lastActiveVbrief: "",
        lastBranch: "main",
      },
      {
        schemaVersion: SCHEMA_VERSION,
        timestamp: "2026-06-09T00:00:00Z",
        lastActiveVbrief: "vbrief/active/x.vbrief.json",
        lastBranch: "",
      },
    ];
    for (const payload of cases) {
      const root = tmpRoot("sent-bad-");
      writeSentinelFile(root, payload);
      expect(readSentinel(root)).toBeNull();
    }
  });

  it("defaults deftVersion to empty string when absent", () => {
    const root = tmpRoot("sent-nover-");
    writeSentinelFile(root, {
      schemaVersion: SCHEMA_VERSION,
      timestamp: "2026-06-09T00:00:00Z",
      lastActiveVbrief: "vbrief/active/x.vbrief.json",
      lastBranch: "main",
    });
    const sentinel = readSentinel(root);
    expect(sentinel?.deftVersion).toBe("");
  });

  it("round-trips a written sentinel and normalises separators", () => {
    const root = tmpRoot("sent-rt-");
    writeSentinel(root, {
      deftVersion: "1.2.3",
      lastActiveVbrief: "vbrief\\active\\x.vbrief.json",
      lastBranch: "feat/x",
      now: new Date("2026-06-09T00:00:00Z"),
    });
    const sentinel = readSentinel(root);
    expect(sentinel?.lastActiveVbrief).toBe("vbrief/active/x.vbrief.json");
    expect(sentinel?.deftVersion).toBe("1.2.3");
    expect(sentinel?.lastBranch).toBe("feat/x");
  });
});

describe("computeResumeSignal branch coverage", () => {
  const now = new Date("2026-06-09T06:00:00Z");

  it("returns null for a null sentinel", () => {
    expect(computeResumeSignal(null, now, tmpRoot("rs-null-"))).toBeNull();
  });

  it("returns null when last active is outside the active prefix", () => {
    const root = tmpRoot("rs-prefix-");
    const sentinel = {
      schemaVersion: SCHEMA_VERSION,
      deftVersion: "",
      timestamp: new Date("2026-06-09T00:00:00Z"),
      lastActiveVbrief: "vbrief/pending/x.vbrief.json",
      lastBranch: "main",
    };
    expect(computeResumeSignal(sentinel, now, root)).toBeNull();
  });

  it("returns null when the session is too recent", () => {
    const root = tmpRoot("rs-recent-");
    const sentinel = {
      schemaVersion: SCHEMA_VERSION,
      deftVersion: "",
      timestamp: new Date("2026-06-09T05:30:00Z"),
      lastActiveVbrief: `${ACTIVE_VBRIEF_PREFIX}x.vbrief.json`,
      lastBranch: "main",
    };
    expect(computeResumeSignal(sentinel, now, root)).toBeNull();
  });

  it("returns null when the referenced vBRIEF no longer exists", () => {
    const root = tmpRoot("rs-gone-");
    const sentinel = {
      schemaVersion: SCHEMA_VERSION,
      deftVersion: "",
      timestamp: new Date("2026-06-09T00:00:00Z"),
      lastActiveVbrief: `${ACTIVE_VBRIEF_PREFIX}gone.vbrief.json`,
      lastBranch: "main",
    };
    expect(computeResumeSignal(sentinel, now, root)).toBeNull();
  });

  it("emits a resume signal when all conditions hold", () => {
    const root = tmpRoot("rs-ok-");
    mkdirSync(join(root, "vbrief", "active"), { recursive: true });
    writeFileSync(join(root, "vbrief", "active", "x.vbrief.json"), "{}\n", "utf8");
    const sentinel = {
      schemaVersion: SCHEMA_VERSION,
      deftVersion: "",
      timestamp: new Date("2026-06-09T00:00:00Z"),
      lastActiveVbrief: `${ACTIVE_VBRIEF_PREFIX}x.vbrief.json`,
      lastBranch: "feat/x",
    };
    const signal = computeResumeSignal(sentinel, now, root);
    expect(signal).toContain("Last session");
    expect(signal).toContain("feat/x");
    expect(signal).toContain("6h ago");
  });
});

describe("detectLatestActiveVbrief branch coverage", () => {
  it("returns null when the active directory is missing", () => {
    expect(detectLatestActiveVbrief(tmpRoot("det-missing-"))).toBeNull();
  });

  it("returns null when there are no vBRIEF files", () => {
    const root = tmpRoot("det-empty-");
    mkdirSync(join(root, "vbrief", "active"), { recursive: true });
    writeFileSync(join(root, "vbrief", "active", "README.md"), "x\n", "utf8");
    expect(detectLatestActiveVbrief(root)).toBeNull();
  });

  it("returns the most recently modified vBRIEF", () => {
    const root = tmpRoot("det-latest-");
    const dir = join(root, "vbrief", "active");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "old.vbrief.json"), "{}\n", "utf8");
    writeFileSync(join(dir, "new.vbrief.json"), "{}\n", "utf8");
    utimesSync(
      join(dir, "old.vbrief.json"),
      new Date("2026-06-01T00:00:00Z"),
      new Date("2026-06-01T00:00:00Z"),
    );
    utimesSync(
      join(dir, "new.vbrief.json"),
      new Date("2026-06-09T00:00:00Z"),
      new Date("2026-06-09T00:00:00Z"),
    );
    expect(detectLatestActiveVbrief(root)).toBe("vbrief/active/new.vbrief.json");
  });
});
