import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearRegistryCache, readEvents } from "../lifecycle/events.js";
import {
  computeCeremonyCostRollup,
  emitSessionRitualBlockedProcessCost,
  emitSessionStartProcessCost,
  formatCeremonyCostReport,
  formatSessionStartCeremonyCostLine,
  PROCESS_COST_EVENT_NAMES,
  PROCESS_COST_REQUIRED_PAYLOAD,
} from "./process-cost.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "process-cost-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  clearRegistryCache();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("process-cost constants (#2994)", () => {
  it("names are registry-compliant colon style", () => {
    expect(PROCESS_COST_EVENT_NAMES.sessionStart).toBe("session:start");
    expect(PROCESS_COST_EVENT_NAMES.sessionRitualBlocked).toBe("session:ritual-blocked");
    expect(PROCESS_COST_REQUIRED_PAYLOAD["session:start"]).toEqual([
      "ceremony_tier",
      "duration_ms",
      "exit_code",
    ]);
    expect(PROCESS_COST_REQUIRED_PAYLOAD["session:ritual-blocked"]).toEqual(["tool_name", "code"]);
  });
});

describe("emitSessionStartProcessCost (#2994)", () => {
  it("appends session:start with timing payload", () => {
    const root = tempRoot();
    const log = join(root, "events.jsonl");
    const record = emitSessionStartProcessCost(
      {
        ceremonyTier: "cold",
        durationMs: 42,
        exitCode: 0,
        ready: true,
        optionalNetwork: false,
        steps: [
          { name: "alignment", duration_ms: 1 },
          { name: "release_probe", duration_ms: 0, skipped: true },
        ],
      },
      { projectRoot: root, logPath: log },
    );
    expect(record).not.toBeNull();
    expect(record?.event).toBe("session:start");
    expect(record?.payload).toMatchObject({
      ceremony_tier: "cold",
      duration_ms: 42,
      exit_code: 0,
      ready: true,
      optional_network: false,
    });
    expect(record?.payload.steps).toEqual([
      { name: "alignment", duration_ms: 1 },
      { name: "release_probe", duration_ms: 0, skipped: true },
    ]);
    const lines = readEvents(log);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.event).toBe("session:start");
  });

  it("returns null and does not throw when emit fails", () => {
    const root = tempRoot();
    // Create a file where a directory is needed so contained write fails.
    const badLog = join(root, "not-a-dir");
    writeFileSync(badLog, "x", "utf8");
    const record = emitSessionStartProcessCost(
      {
        ceremonyTier: "rearm",
        durationMs: 1,
        exitCode: 0,
      },
      { projectRoot: root, logPath: join(badLog, "events.jsonl") },
    );
    expect(record).toBeNull();
  });

  it("honors DEFT_EVENT_LOG when logPath is omitted", () => {
    const root = tempRoot();
    const envLog = join(root, "custom-events.jsonl");
    const prev = process.env.DEFT_EVENT_LOG;
    process.env.DEFT_EVENT_LOG = envLog;
    try {
      const record = emitSessionStartProcessCost(
        {
          ceremonyTier: "cold",
          durationMs: 3,
          exitCode: 0,
          ready: true,
        },
        { projectRoot: root },
      );
      expect(record).not.toBeNull();
      expect(readEvents(envLog)).toHaveLength(1);
    } finally {
      if (prev === undefined) {
        delete process.env.DEFT_EVENT_LOG;
      } else {
        process.env.DEFT_EVENT_LOG = prev;
      }
    }
  });
});

describe("emitSessionRitualBlockedProcessCost (#2994)", () => {
  it("appends session:ritual-blocked with tool and recovery", () => {
    const root = tempRoot();
    const log = join(root, "events.jsonl");
    const record = emitSessionRitualBlockedProcessCost(
      {
        toolName: "Write",
        recoveryTier: "rearm",
        detail: "ritual age stale",
      },
      { projectRoot: root, logPath: log },
    );
    expect(record).not.toBeNull();
    expect(record?.event).toBe("session:ritual-blocked");
    expect(record?.payload).toEqual({
      tool_name: "Write",
      code: "ritual-not-ready",
      recovery_tier: "rearm",
      detail: "ritual age stale",
    });
    expect(readFileSync(log, "utf8")).toContain("session:ritual-blocked");
  });

  it("caps long detail strings", () => {
    const root = tempRoot();
    const log = join(root, "events.jsonl");
    const long = "x".repeat(300);
    const record = emitSessionRitualBlockedProcessCost(
      { toolName: "Shell", detail: long, recoveryTier: "cold" },
      { projectRoot: root, logPath: log },
    );
    expect(record).not.toBeNull();
    expect(typeof record?.payload.detail).toBe("string");
    expect((record?.payload.detail as string).length).toBeLessThanOrEqual(240);
    expect((record?.payload.detail as string).endsWith("...")).toBe(true);
  });

  it("omits empty detail and default code when code provided (#3003)", () => {
    const root = tempRoot();
    const log = join(root, "events.jsonl");
    const record = emitSessionRitualBlockedProcessCost(
      { toolName: "Write", code: "ritual-stale", detail: "" },
      { projectRoot: root, logPath: log },
    );
    expect(record).not.toBeNull();
    expect(record?.payload).toEqual({
      tool_name: "Write",
      code: "ritual-stale",
    });
    expect(record?.payload).not.toHaveProperty("detail");
    expect(record?.payload).not.toHaveProperty("recovery_tier");
  });

  it("includes non-skipped steps without skipped flag (#3003)", () => {
    const root = tempRoot();
    const log = join(root, "events.jsonl");
    const record = emitSessionStartProcessCost(
      {
        ceremonyTier: "cold",
        durationMs: 5,
        exitCode: 0,
        steps: [
          { name: "alignment", duration_ms: 2, skipped: false },
          { name: "branch_policy", duration_ms: 3 },
        ],
      },
      { projectRoot: root, logPath: log },
    );
    expect(record?.payload.steps).toEqual([
      { name: "alignment", duration_ms: 2 },
      { name: "branch_policy", duration_ms: 3 },
    ]);
  });

  it("returns null without throwing on failure", () => {
    const root = tempRoot();
    const bad = join(root, "file-not-dir");
    writeFileSync(bad, "x", "utf8");
    expect(
      emitSessionRitualBlockedProcessCost(
        { toolName: "Write" },
        { projectRoot: root, logPath: join(bad, "events.jsonl") },
      ),
    ).toBeNull();
  });
});

describe("ceremony-cost reader (#3508)", () => {
  function writeLedger(
    root: string,
    rows: Array<{ event: string; payload: Record<string, unknown>; detected_at: string }>,
  ): string {
    mkdirSync(join(root, ".deft-cache"), { recursive: true });
    const log = join(root, ".deft-cache", "events.jsonl");
    const lines = rows.map((row, index) =>
      JSON.stringify({
        event: row.event,
        id: `pc-${index}`,
        detected_at: row.detected_at,
        payload: row.payload,
      }),
    );
    writeFileSync(log, `${lines.join("\n")}\n`, "utf8");
    return log;
  }

  it("rolls up last cold vs re-arm, steps, blocked-ritual, and recovery tiers", () => {
    const root = tempRoot();
    writeLedger(root, [
      {
        event: PROCESS_COST_EVENT_NAMES.sessionStart,
        detected_at: "2026-08-19T10:00:00Z",
        payload: {
          ceremony_tier: "cold",
          duration_ms: 1200,
          exit_code: 0,
          steps: [{ name: "alignment", duration_ms: 10 }],
        },
      },
      {
        event: PROCESS_COST_EVENT_NAMES.sessionStart,
        detected_at: "2026-08-19T11:00:00Z",
        payload: {
          ceremony_tier: "rearm",
          duration_ms: 40,
          exit_code: 0,
          steps: [
            { name: "alignment", duration_ms: 0 },
            { name: "ritual_write", duration_ms: 5 },
          ],
        },
      },
      {
        event: PROCESS_COST_EVENT_NAMES.sessionRitualBlocked,
        detected_at: "2026-08-19T11:05:00Z",
        payload: { tool_name: "Write", code: "ritual-not-ready", recovery_tier: "rearm" },
      },
      {
        event: PROCESS_COST_EVENT_NAMES.sessionRitualBlocked,
        detected_at: "2026-08-19T11:06:00Z",
        payload: { tool_name: "Shell", code: "ritual-not-ready" },
      },
      {
        event: "value:gate-catch",
        detected_at: "2026-08-19T11:07:00Z",
        payload: { source: "verify:branch" },
      },
    ]);
    const rollup = computeCeremonyCostRollup({
      projectRoot: root,
      now: new Date("2026-08-20T00:00:00Z"),
      windowMs: 7 * 86_400_000,
    });
    expect(rollup.kind).toBe("cli_process_time");
    expect(rollup.lastColdDurationMs).toBe(1200);
    expect(rollup.lastRearmDurationMs).toBe(40);
    expect(rollup.lastColdSteps).toEqual([{ name: "alignment", duration_ms: 10 }]);
    expect(rollup.lastRearmSteps).toEqual([
      { name: "alignment", duration_ms: 0 },
      { name: "ritual_write", duration_ms: 5 },
    ]);
    expect(rollup.blockedRitualCount).toBe(2);
    expect(rollup.recoveryTierDistribution).toEqual({ rearm: 1, unspecified: 1 });
    const report = formatCeremonyCostReport(rollup);
    expect(report).toContain("CLI process time");
    expect(report).toContain("not agent-turn wall clock");
    expect(report).toContain("last cold: 1200ms");
    expect(report).toContain("last re-arm: 40ms");
    expect(report).toContain("blocked-ritual");
    expect(report).toContain("rearm=1");
  });

  it("returns empty rollup when the ledger is missing", () => {
    const root = tempRoot();
    const rollup = computeCeremonyCostRollup({ projectRoot: root });
    expect(rollup.lastColdDurationMs).toBeNull();
    expect(rollup.lastRearmDurationMs).toBeNull();
    expect(rollup.lastColdSteps).toEqual([]);
    expect(rollup.lastRearmSteps).toEqual([]);
    expect(rollup.blockedRitualCount).toBe(0);
    expect(formatCeremonyCostReport(rollup)).toContain("last cold: none");
  });

  it("drops events outside the window and skips malformed steps", () => {
    const root = tempRoot();
    writeLedger(root, [
      {
        event: PROCESS_COST_EVENT_NAMES.sessionStart,
        detected_at: "2026-07-01T00:00:00Z",
        payload: { ceremony_tier: "cold", duration_ms: 9999, exit_code: 0 },
      },
      {
        event: PROCESS_COST_EVENT_NAMES.sessionStart,
        detected_at: "2026-08-19T12:00:00Z",
        payload: {
          ceremony_tier: "cold",
          duration_ms: 8,
          exit_code: 0,
          steps: [
            { name: "alignment", duration_ms: 3, skipped: true },
            { name: 1, duration_ms: 2 },
            "nope",
            { name: "ritual_write", duration_ms: Number.NaN },
          ],
        },
      },
    ]);
    const rollup = computeCeremonyCostRollup({
      projectRoot: root,
      now: new Date("2026-08-20T00:00:00Z"),
      windowMs: 2 * 86_400_000,
    });
    expect(rollup.lastColdDurationMs).toBe(8);
    expect(rollup.lastRearmDurationMs).toBeNull();
    expect(rollup.lastColdSteps).toEqual([{ name: "alignment", duration_ms: 3, skipped: true }]);
    expect(rollup.lastRearmSteps).toEqual([]);
    expect(formatCeremonyCostReport(rollup)).toContain("alignment=3ms skipped");
  });

  it("formats the operator-visible session:start line with tier and total", () => {
    expect(formatSessionStartCeremonyCostLine("cold", 42)).toBe(
      "[deft session] ceremony cold 42ms",
    );
    expect(formatSessionStartCeremonyCostLine("rearm", 7)).toBe(
      "[deft session] ceremony rearm 7ms",
    );
  });

  it("honors explicit logPath, missing timestamps, and non-numeric duration", () => {
    const root = tempRoot();
    const log = join(root, "custom.jsonl");
    writeFileSync(
      log,
      `${JSON.stringify({
        event: PROCESS_COST_EVENT_NAMES.sessionStart,
        id: "no-ts",
        payload: { ceremony_tier: "cold", duration_ms: "slow", exit_code: 0 },
      })}\n${JSON.stringify({
        event: PROCESS_COST_EVENT_NAMES.sessionStart,
        id: "bad-date",
        detected_at: "not-a-date",
        payload: { ceremony_tier: "rearm", duration_ms: 9, exit_code: 0 },
      })}\n${JSON.stringify({
        event: PROCESS_COST_EVENT_NAMES.sessionRitualBlocked,
        id: "empty-tier",
        detected_at: "2026-08-19T00:00:00+00:00",
        payload: { tool_name: "Write", code: "ritual-not-ready", recovery_tier: "  " },
      })}\n`,
      "utf8",
    );
    const rollup = computeCeremonyCostRollup({
      projectRoot: root,
      logPath: log,
      now: new Date("2026-08-20T00:00:00Z"),
      windowMs: 7 * 86_400_000,
      windowLabel: "week",
    });
    expect(rollup.windowLabel).toBe("week");
    expect(rollup.lastColdDurationMs).toBeNull();
    expect(rollup.lastRearmDurationMs).toBe(9);
    expect(rollup.blockedRitualCount).toBe(1);
    expect(rollup.recoveryTierDistribution).toEqual({ unspecified: 1 });
  });

  it("labels short windows and empty recovery, and fail-opens on unreadable logs", () => {
    const root = tempRoot();
    expect(computeCeremonyCostRollup({ projectRoot: root, windowMs: 3_600_000 }).windowLabel).toBe(
      "1h",
    );
    expect(computeCeremonyCostRollup({ projectRoot: root, windowMs: 1500 }).windowLabel).toBe(
      "1500ms",
    );
    const dirLog = join(root, "not-a-file");
    mkdirSync(dirLog, { recursive: true });
    const rollup = computeCeremonyCostRollup({ projectRoot: root, logPath: dirLog });
    expect(rollup.blockedRitualCount).toBe(0);
    expect(formatCeremonyCostReport(rollup)).toContain("recovery-tier: none");
  });
});
