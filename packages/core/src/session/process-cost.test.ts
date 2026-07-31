import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearRegistryCache, readEvents } from "../lifecycle/events.js";
import {
  emitSessionRitualBlockedProcessCost,
  emitSessionStartProcessCost,
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
