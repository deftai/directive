import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  markPhaseCompleted,
  newReleaseRunRecord,
  nextReleaseRunPhase,
  parseReleaseRunRecord,
  RELEASE_RUN_PHASES,
  readReleaseRunRecord,
  releaseRunRecordPath,
  writeReleaseRunRecord,
} from "./run-record.js";

const NOW = new Date("2026-11-22T00:00:00Z");

function fresh() {
  return newReleaseRunRecord({
    version: "1.2.0",
    repo: "o/r",
    baseBranch: "master",
    expires: "2026-11-22T06:00:00Z",
    promoteLatest: false,
    summary: null,
    ciReuseAtReadiness: "reuse",
    now: NOW,
  });
}

describe("release:run record (#6876)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("stores the record under .deft-scratch/release-run/<version>.json and reads it back", () => {
    const root = mkdtempSync(join(tmpdir(), "w6876-record-"));
    dirs.push(root);
    expect(readReleaseRunRecord(root, "1.2.0")).toEqual({ kind: "absent" });
    const record = {
      ...fresh(),
      cutBase: "b".repeat(40),
      releaseTree: "t".repeat(40),
      pr: 12,
      grants: { releasePublish: "g1", promoteLatest: null },
    };
    const path = writeReleaseRunRecord(root, record);
    expect(path).toBe(join(root, ".deft-scratch", "release-run", "1.2.0.json"));
    expect(readReleaseRunRecord(root, "1.2.0")).toEqual({ kind: "ok", record });
  });

  it("walks the phases in order and reports null when every phase is done", () => {
    let record = fresh();
    for (const phase of RELEASE_RUN_PHASES) {
      expect(nextReleaseRunPhase(record)).toBe(phase);
      record = markPhaseCompleted(record, phase, NOW);
    }
    expect(nextReleaseRunPhase(record)).toBeNull();
    expect(markPhaseCompleted(record, "setup", NOW).completed).toHaveLength(
      RELEASE_RUN_PHASES.length,
    );
  });

  it("returns a reason for every malformed record instead of throwing", () => {
    const good = fresh();
    const cases: Array<[string, string]> = [
      ["{", "not JSON"],
      ["[]", "not a JSON object"],
      [JSON.stringify({ ...good, schema: "x" }), "schema"],
      [JSON.stringify({ ...good, version: "9.9.9" }), "version 9.9.9"],
      [JSON.stringify({ ...good, repo: 1 }), "repo is not a string"],
      [JSON.stringify({ ...good, cutBase: 3 }), "cutBase is not a string or null"],
      [JSON.stringify({ ...good, promoteLatest: "no" }), "promoteLatest"],
      [JSON.stringify({ ...good, pr: -1 }), "pr is not"],
      [JSON.stringify({ ...good, grants: null }), "grants"],
      [JSON.stringify({ ...good, grants: { releasePublish: 1, promoteLatest: null } }), "grants"],
      [JSON.stringify({ ...good, completed: ["nope"] }), "completed"],
    ];
    for (const [raw, reason] of cases) {
      const parsed = parseReleaseRunRecord(raw, "1.2.0");
      expect(parsed.kind).toBe("invalid");
      if (parsed.kind === "invalid") expect(parsed.reason).toContain(reason);
    }
  });

  it("keeps the re-run count and the enqueue; an older record reads as none used (#6877)", () => {
    const good = fresh();
    expect(good.retries).toEqual({ failedCheck: 0 });
    expect(good.enqueue).toBeNull();
    const stored = { ...good, retries: { failedCheck: 1 }, enqueue: { head: "h", since: "s" } };
    expect(parseReleaseRunRecord(JSON.stringify(stored), "1.2.0")).toEqual({
      kind: "ok",
      record: stored,
    });
    const { retries: _r, enqueue: _e, ...older } = good;
    const parsed = parseReleaseRunRecord(JSON.stringify(older), "1.2.0");
    expect(parsed.kind === "ok" && parsed.record.retries).toEqual({ failedCheck: 0 });
    expect(parsed.kind === "ok" && parsed.record.enqueue).toBeNull();
    const bad: Array<[unknown, string]> = [
      [{ ...good, retries: null }, "retries"],
      [{ ...good, retries: { failedCheck: -1 } }, "retries"],
      [{ ...good, retries: { failedCheck: 0.5 } }, "retries"],
      [{ ...good, enqueue: { head: 1, since: "s" } }, "enqueue"],
      [{ ...good, enqueue: ["h", "s"] }, "enqueue"],
    ];
    for (const [record, reason] of bad) {
      const out = parseReleaseRunRecord(JSON.stringify(record), "1.2.0");
      expect(out.kind).toBe("invalid");
      if (out.kind === "invalid") expect(out.reason).toContain(reason);
    }
  });

  it("reports an unreadable record path as invalid", () => {
    const root = mkdtempSync(join(tmpdir(), "w6876-record-"));
    dirs.push(root);
    const path = releaseRunRecordPath(root, "1.2.0");
    mkdirSync(path, { recursive: true });
    expect(readReleaseRunRecord(root, "1.2.0").kind).toBe("invalid");
    rmSync(path, { recursive: true, force: true });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{", "utf8");
    expect(readReleaseRunRecord(root, "1.2.0").kind).toBe("invalid");
  });
});

describe("release:run record write (#6876)", () => {
  it("replaces the record through a temp file and leaves no temp file behind", () => {
    const root = mkdtempSync(join(tmpdir(), "w6876-record-"));
    try {
      writeReleaseRunRecord(root, fresh());
      writeReleaseRunRecord(root, { ...fresh(), pr: 3 });
      const read = readReleaseRunRecord(root, "1.2.0");
      expect(read.kind === "ok" && read.record.pr).toBe(3);
      expect(existsSync(`${releaseRunRecordPath(root, "1.2.0")}.tmp`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
