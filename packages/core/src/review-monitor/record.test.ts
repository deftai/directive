import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findActiveMonitorForPr,
  isRecordActive,
  parseIso8601Utc,
  type ReviewMonitorRecord,
  readReviewMonitorFile,
  registerReviewMonitor,
  reviewMonitorPath,
} from "./record.js";

function baseRecord(overrides: Partial<ReviewMonitorRecord> = {}): ReviewMonitorRecord {
  return {
    pr: 1,
    repo: null,
    head_sha: "abc",
    platform_primitive: "cursor-task",
    monitor_agent_id: "rm-1",
    started_at: new Date().toISOString(),
    worktree_path: "/tmp/wt",
    parent_session_id: null,
    ended_at: null,
    ...overrides,
  };
}

describe("review-monitor record", () => {
  it("writes under .deft/review-monitor.json", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-record-"));
    const { path } = registerReviewMonitor({
      pr: 3,
      platformPrimitive: "cursor-task",
      monitorAgentId: "rm-3",
      projectRoot: root,
    });
    expect(path).toBe(reviewMonitorPath(root));
    expect(path).toContain("review-monitor.json");
  });

  it("replaces prior active record for the same PR", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-replace-"));
    registerReviewMonitor({
      pr: 5,
      platformPrimitive: "cursor-task",
      monitorAgentId: "old",
      projectRoot: root,
      headSha: "aaa",
    });
    registerReviewMonitor({
      pr: 5,
      platformPrimitive: "spawn_subagent",
      monitorAgentId: "new",
      projectRoot: root,
      headSha: "bbb",
      repo: "deftai/directive",
      parentSessionId: "sess",
    });
    const { data } = readReviewMonitorFile(reviewMonitorPath(root));
    expect(data?.records).toHaveLength(1);
    expect(data?.records[0]?.monitor_agent_id).toBe("new");
    expect(data?.records[0]?.repo).toBe("deftai/directive");
  });

  it("keeps other PRs when registering", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-keep-"));
    registerReviewMonitor({
      pr: 1,
      platformPrimitive: "cursor-task",
      monitorAgentId: "a",
      projectRoot: root,
    });
    registerReviewMonitor({
      pr: 2,
      platformPrimitive: "cursor-task",
      monitorAgentId: "b",
      projectRoot: root,
    });
    const { data } = readReviewMonitorFile(reviewMonitorPath(root));
    expect(data?.records).toHaveLength(2);
  });

  it("rejects invalid JSON and non-object payloads", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-bad-"));
    mkdirSync(join(root, ".deft"), { recursive: true });
    const path = join(root, ".deft", "review-monitor.json");
    writeFileSync(path, "{not-json", "utf8");
    expect(readReviewMonitorFile(path).error).toMatch(/invalid JSON/);
    writeFileSync(path, "[]", "utf8");
    expect(readReviewMonitorFile(path).error).toMatch(/JSON object/);
  });

  it("skips malformed record entries", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-skip-"));
    mkdirSync(join(root, ".deft"), { recursive: true });
    const path = join(root, ".deft", "review-monitor.json");
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: 1,
        records: [
          null,
          "x",
          { pr: -1, monitor_agent_id: "bad" },
          {
            pr: 9,
            monitor_agent_id: "ok",
            platform_primitive: "cursor-task",
            started_at: new Date().toISOString(),
            worktree_path: root,
          },
        ],
      }),
      "utf8",
    );
    const { data } = readReviewMonitorFile(path);
    expect(data?.records).toHaveLength(1);
    expect(data?.records[0]?.pr).toBe(9);
  });

  it("parseIso8601Utc accepts Z and rejects local offsets", () => {
    expect(parseIso8601Utc("")).toBeNull();
    expect(parseIso8601Utc("2026-07-20T00:00:00+01:00")).toBeNull();
    expect(parseIso8601Utc("not-a-dateZ")).toBeNull();
    expect(parseIso8601Utc("2026-07-20T00:00:00.000Z")).toBeInstanceOf(Date);
  });

  it("isRecordActive rejects ended, stale, and sha mismatch", () => {
    const now = new Date("2026-07-20T12:00:00.000Z");
    expect(isRecordActive(baseRecord({ ended_at: now.toISOString() }), { now })).toBe(false);
    expect(isRecordActive(baseRecord({ started_at: "bad-date" }), { now })).toBe(false);
    expect(
      isRecordActive(baseRecord({ started_at: "2026-07-20T10:00:00.000Z" }), {
        now,
        staleMinutes: 30,
      }),
    ).toBe(false);
    expect(
      isRecordActive(baseRecord({ head_sha: "aaa", started_at: "2026-07-20T11:50:00.000Z" }), {
        now,
        headSha: "bbb",
      }),
    ).toBe(false);
    expect(
      isRecordActive(baseRecord({ head_sha: null, started_at: "2026-07-20T11:50:00.000Z" }), {
        now,
        headSha: "bbb",
      }),
    ).toBe(true);
  });

  it("findActiveMonitorForPr prefers newest started_at", () => {
    const now = new Date("2026-07-20T12:00:00.000Z");
    const file = {
      schema_version: 1,
      records: [
        baseRecord({
          pr: 4,
          monitor_agent_id: "older",
          started_at: "2026-07-20T11:40:00.000Z",
        }),
        baseRecord({
          pr: 4,
          monitor_agent_id: "newer",
          started_at: "2026-07-20T11:50:00.000Z",
        }),
      ],
    };
    expect(findActiveMonitorForPr(file, 4, { now })?.monitor_agent_id).toBe("newer");
    expect(findActiveMonitorForPr(file, 99, { now })).toBeNull();
  });
});
