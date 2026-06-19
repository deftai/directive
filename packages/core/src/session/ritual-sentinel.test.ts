import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sortKeys, stableJson } from "./json.js";
import {
  computeResumeSignal,
  newRitualStatePayload,
  readRitualState,
  readSentinel,
  ritualStep,
  writeRitualState,
  writeSentinel,
} from "./ritual-sentinel.js";
import { parseTimestamp, timestampIso } from "./time.js";

describe("session json/time", () => {
  it("sortKeys orders nested objects", () => {
    expect(sortKeys({ b: 1, a: { d: 2, c: 3 } })).toEqual({ a: { c: 3, d: 2 }, b: 1 });
  });

  it("timestampIso drops milliseconds", () => {
    expect(timestampIso(new Date("2026-06-09T01:02:03.456Z"))).toBe("2026-06-09T01:02:03Z");
  });

  it("parseTimestamp accepts Z suffix", () => {
    const dt = parseTimestamp("2026-06-09T01:00:00Z");
    expect(dt?.toISOString()).toBe("2026-06-09T01:00:00.000Z");
  });
});

describe("ritual sentinel", () => {
  it("round-trips ritual state", () => {
    const root = mkdtempSync(join(tmpdir(), "session-rs-"));
    const now = new Date("2026-06-09T01:00:00Z");
    writeRitualState(
      root,
      newRitualStatePayload({
        sessionId: "s1",
        gitHead: "abc",
        worktreePath: root,
        startedAt: now,
        quickSteps: { alignment: ritualStep({ ok: true, ts: now }) },
      }),
    );
    const [state, err] = readRitualState(root);
    expect(err).toBeNull();
    expect(state?.sessionId).toBe("s1");
    expect(stableJson(state?.raw, 2)).toContain('"session_id"');
    rmSync(root, { recursive: true, force: true });
  });

  it("writeSentinel and computeResumeSignal", () => {
    const root = mkdtempSync(join(tmpdir(), "session-sent-"));
    mkdirSync(join(root, "vbrief", "active"), { recursive: true });
    writeFileSync(join(root, "vbrief", "active", "x.vbrief.json"), "{}\n", "utf8");
    const ts = new Date("2026-06-08T00:00:00Z");
    writeSentinel(root, {
      deftVersion: "0.1.0",
      lastActiveVbrief: "vbrief/active/x.vbrief.json",
      lastBranch: "main",
      now: ts,
    });
    const sentinel = readSentinel(root);
    expect(sentinel?.lastBranch).toBe("main");
    expect(computeResumeSignal(sentinel, new Date("2026-06-09T01:00:00Z"), root)).toContain(
      "Resume?",
    );
    rmSync(root, { recursive: true, force: true });
  });
});
