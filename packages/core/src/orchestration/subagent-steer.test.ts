import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sweepScratchDirs } from "./subagent-monitor.js";
import {
  applyUnreadSteer,
  assertSteerWriter,
  defaultSteerDir,
  parseSteerFile,
  renderSteerPendingText,
  STEER_ACK_SCHEMA,
  STEER_SCHEMA,
  STEER_TEXT_MAX_CHARS,
  sweepSteerPending,
  writeSteer,
} from "./subagent-steer.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("subagent-steer inbox (#4286)", () => {
  it("parses a closed-schema inbox and flags unread as pending, not REDISPATCH_OK", () => {
    const root = tempRoot("steer-pending-");
    const steerDir = join(root, ".deft-scratch", "subagent-steer");
    const now = new Date("2026-09-09T12:00:00Z");
    writeSteer(steerDir, {
      agentId: "leaf-a",
      writerKind: "dispatching-parent",
      writerId: "parent-1",
      kind: "constraint",
      text: "do not git rm leftover 3785",
      steerId: "steer-1",
      writtenAt: new Date("2026-09-09T11:59:00Z"),
      ttlSeconds: 1800,
    });

    const sweep = sweepSteerPending(steerDir, { now, agentIds: ["leaf-a"] });
    expect(sweep.pending).toHaveLength(1);
    expect(sweep.pending[0]?.steer_id).toBe("steer-1");
    const text = renderSteerPendingText(sweep);
    expect(text).toContain("STEER_PENDING");
    expect(text).not.toContain("REDISPATCH_OK");
  });

  it("apply-once ack clears pending; a second apply is already-acked", () => {
    const root = tempRoot("steer-ack-");
    const steerDir = join(root, "inbox");
    const now = new Date("2026-09-09T12:00:00Z");
    writeSteer(steerDir, {
      agentId: "leaf-a",
      writerKind: "occupancy-owner",
      writerId: "owner-1",
      kind: "correction",
      text: "run verify:ac against 4286 only",
      steerId: "steer-2",
      writtenAt: now,
      occupancyOwnerId: "owner-1",
    });

    const first = applyUnreadSteer(steerDir, "leaf-a", {
      now,
      occupancyOwnerId: "owner-1",
    });
    expect(first.applied).toBe(true);
    expect(first.reason).toBe("applied");
    expect(first.record?.schema).toBe(STEER_SCHEMA);

    const second = applyUnreadSteer(steerDir, "leaf-a", {
      now: new Date("2026-09-09T12:01:00Z"),
      occupancyOwnerId: "owner-1",
    });
    expect(second.applied).toBe(false);
    expect(second.reason).toBe("already-acked");
    expect(sweepSteerPending(steerDir, { now }).pending).toEqual([]);
  });

  it("expired unread is not pending and apply refuses expired", () => {
    const root = tempRoot("steer-exp-");
    const steerDir = join(root, "inbox");
    writeSteer(steerDir, {
      agentId: "leaf-a",
      writerKind: "dispatching-parent",
      writerId: "parent-1",
      kind: "halt",
      text: "stop check and wait",
      steerId: "steer-3",
      writtenAt: new Date("2026-09-09T11:00:00Z"),
      ttlSeconds: 60,
    });
    const now = new Date("2026-09-09T12:00:00Z");
    expect(sweepSteerPending(steerDir, { now }).pending).toEqual([]);
    expect(applyUnreadSteer(steerDir, "leaf-a", { now }).reason).toBe("expired");
  });

  it("refuses occupancy-owner writer that does not match occupancy", () => {
    expect(assertSteerWriter("occupancy-owner", "other", { occupancyOwnerId: "owner-1" })).toMatch(
      /does not match occupancy owner/,
    );
    const root = tempRoot("steer-writer-");
    const steerDir = join(root, "inbox");
    expect(() =>
      writeSteer(steerDir, {
        agentId: "leaf-a",
        writerKind: "occupancy-owner",
        writerId: "other",
        kind: "note",
        text: "hello",
        occupancyOwnerId: "owner-1",
      }),
    ).toThrow(/does not match occupancy owner/);
  });

  it("rejects free-form schema, empty text, and oversize text", () => {
    const root = tempRoot("steer-schema-");
    const steerDir = join(root, "inbox");
    mkdirSync(steerDir, { recursive: true });
    writeFileSync(
      join(steerDir, "leaf-a.json"),
      JSON.stringify({ schema: "not-steer", agent_id: "leaf-a", text: "x" }),
      "utf8",
    );
    const parsed = parseSteerFile(join(steerDir, "leaf-a.json"));
    expect(parsed.record).toBeNull();
    expect(parsed.failures.some((f) => f.includes(STEER_SCHEMA))).toBe(true);

    expect(() =>
      writeSteer(steerDir, {
        agentId: "leaf-b",
        writerKind: "dispatching-parent",
        writerId: "p",
        kind: "note",
        text: "   ",
      }),
    ).toThrow(/non-empty/);
    expect(() =>
      writeSteer(steerDir, {
        agentId: "leaf-b",
        writerKind: "dispatching-parent",
        writerId: "p",
        kind: "note",
        text: "x".repeat(STEER_TEXT_MAX_CHARS + 1),
      }),
    ).toThrow(/exceeds/);
  });

  it("missing steer dir is not pending and is not a config error", () => {
    const root = tempRoot("steer-missing-");
    const sweep = sweepSteerPending(join(root, "no-such-dir"));
    expect(sweep.pending).toEqual([]);
    expect(sweep.sweep_errors).toEqual([]);
    expect(renderSteerPendingText(sweep)).toContain("no unread steer");
    expect(defaultSteerDir(root)).toContain("subagent-steer");
  });

  it("heartbeat sweep skips steer schema JSON and subdirectory files (#4286 carve-out)", () => {
    const root = tempRoot("steer-sweep-");
    const scratch = join(root, ".deft-scratch", "subagent-status");
    mkdirSync(join(scratch, "steer"), { recursive: true });
    const now = new Date("2026-09-09T12:00:00Z");
    writeFileSync(
      join(scratch, "leaf-a.json"),
      JSON.stringify({
        agent_id: "leaf-a",
        parent_id: "p",
        last_heartbeat_at: "2026-09-09T11:59:00Z",
        last_message: "ok",
        phase: "implementing",
      }),
      "utf8",
    );
    writeFileSync(
      join(scratch, "stray-steer.json"),
      JSON.stringify({
        schema: STEER_SCHEMA,
        agent_id: "stray-steer",
        steer_id: "x",
        written_at: "2026-09-09T11:59:00Z",
        expires_at: "2026-09-09T12:30:00Z",
        writer_kind: "dispatching-parent",
        writer_id: "p",
        kind: "note",
        text: "should not trip REDISPATCH_OK",
      }),
      "utf8",
    );
    writeFileSync(
      join(scratch, "leaf-a.ack.json"),
      JSON.stringify({ schema: STEER_ACK_SCHEMA, agent_id: "leaf-a", steer_id: "x" }),
      "utf8",
    );
    writeFileSync(
      join(scratch, "steer", "nested.json"),
      JSON.stringify({ not: "a heartbeat" }),
      "utf8",
    );

    const sweep = sweepScratchDirs([{ readPath: scratch, label: scratch }], {
      thresholdMinutes: 30,
      now,
    });
    expect(sweep.records).toHaveLength(1);
    expect(sweep.records[0]?.agent_id).toBe("leaf-a");
    expect(sweep.records.every((r) => r.failures.length === 0)).toBe(true);
  });

  it("steer-dir that is a file is a config error", () => {
    const root = tempRoot("steer-file-");
    const filePath = join(root, "not-a-dir");
    writeFileSync(filePath, "x", "utf8");
    const sweep = sweepSteerPending(filePath);
    expect(sweep.sweep_errors.some((e) => e.includes("not a directory"))).toBe(true);
    expect(renderSteerPendingText(sweep)).toContain("config error");
  });
});
