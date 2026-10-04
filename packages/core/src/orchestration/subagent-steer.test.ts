import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseHeartbeatFile, sweepScratchDirs } from "./subagent-monitor.js";
import {
  ackSteer,
  applyUnreadSteer,
  assertSteerWriter,
  defaultFirstSeenDir,
  defaultSteerDir,
  evaluateApproach1ArmStartup,
  evaluatePreCancel,
  isSafeAgentId,
  parseSteerFile,
  readOrCreateFirstSeen,
  renderSteerPendingText,
  STEER_ACK_SCHEMA,
  STEER_SCHEMA,
  STEER_TEXT_MAX_CHARS,
  steerInboxPath,
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
      parentId: "parent-1",
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
    expect(sweepSteerPending(steerDir, { now }).pending).toHaveLength(1);

    ackSteer(steerDir, "leaf-a", first.record?.steer_id ?? "steer-2", now);

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
      parentId: "parent-1",
    });
    const now = new Date("2026-09-09T12:00:00Z");
    expect(sweepSteerPending(steerDir, { now }).pending).toEqual([]);
    expect(applyUnreadSteer(steerDir, "leaf-a", { now, parentId: "parent-1" }).reason).toBe(
      "expired",
    );
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
        parentId: "p",
      }),
    ).toThrow(/non-empty/);
    expect(() =>
      writeSteer(steerDir, {
        agentId: "leaf-b",
        writerKind: "dispatching-parent",
        writerId: "p",
        kind: "note",
        text: "x".repeat(STEER_TEXT_MAX_CHARS + 1),
        parentId: "p",
      }),
    ).toThrow(/exceeds/);
  });

  it("malformed inbox is parent-visible pending, not a clean success", () => {
    const root = tempRoot("steer-malformed-");
    const steerDir = join(root, "inbox");
    mkdirSync(steerDir, { recursive: true });
    writeFileSync(join(steerDir, "leaf-a.json"), "{not json", "utf8");
    const sweep = sweepSteerPending(steerDir, { now: new Date("2026-09-09T12:00:00Z") });
    expect(sweep.pending).toEqual([]);
    expect(sweep.parse_failures.length).toBeGreaterThan(0);
    expect(renderSteerPendingText(sweep)).toContain("STEER_PENDING");
    expect(renderSteerPendingText(sweep)).toContain("Malformed inbox");
  });

  it("refuses occupancy-owner writes without occupancyOwnerId and unsafe agent ids", () => {
    expect(assertSteerWriter("occupancy-owner", "owner-1", {})).toMatch(
      /requires occupancyOwnerId/,
    );
    expect(assertSteerWriter("dispatching-parent", "parent-1", {})).toMatch(/requires parentId/);
    expect(isSafeAgentId("../other")).toBe(false);
    expect(isSafeAgentId("leaf-a.ack")).toBe(false);
    expect(isSafeAgentId("leaf-a")).toBe(true);
    const root = tempRoot("steer-path-");
    expect(() => steerInboxPath(join(root, "inbox"), "../other")).toThrow(/filesystem-safe/);
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

describe("subagent pre-cancel Prefer-A (#5278)", () => {
  it("DCR (ii): parse_failures keep pre-cancel red; first-seen outside inbox stays clean", () => {
    const root = tempRoot("pre-cancel-p4-");
    const steerDir = join(root, ".deft-scratch", "subagent-steer");
    const firstSeenDir = defaultFirstSeenDir(root);
    const scratchDir = join(root, ".deft-scratch", "subagent-status");
    mkdirSync(steerDir, { recursive: true });
    mkdirSync(scratchDir, { recursive: true });
    writeFileSync(join(steerDir, "leaf-a.json"), "{not-json", "utf8");
    writeFileSync(
      join(scratchDir, "leaf-a.json"),
      JSON.stringify({
        agent_id: "leaf-a",
        parent_id: "p",
        last_heartbeat_at: "2026-10-03T12:00:00Z",
        last_message: "ok",
        phase: "implementing",
      }),
      "utf8",
    );

    const now = new Date("2026-10-03T12:01:00Z");
    const red = evaluatePreCancel({
      agentId: "leaf-a",
      cancellerId: "parent-1",
      steerDir,
      firstSeenDir,
      scratchDir,
      now,
      dispatchStartedAt: "2026-10-03T11:00:00Z",
    });
    expect(red.ok).toBe(false);
    expect(red.refuse_reason).toBe("parse_failures");

    readOrCreateFirstSeen(firstSeenDir, {
      agentId: "leaf-a",
      steerId: "steer-old",
      cancellerId: "parent-1",
      now,
    });
    const sweep = sweepSteerPending(steerDir, { now });
    expect(sweep.pending.every((p) => !p.path.includes("firstseen"))).toBe(true);
    // Sibling first-seen dir is not swept; unfiltered steer sweep must not stick on first-seen.
    expect(defaultFirstSeenDir(root)).toContain("subagent-steer-firstseen");
    expect(isSafeAgentId("leaf-a.firstseen")).toBe(false);
  });

  it("DCR (iv): TTL-aged pending status steer clears after observed first-seen window; no behind skew", () => {
    const root = tempRoot("pre-cancel-aged-");
    const steerDir = join(root, "inbox");
    const firstSeenDir = join(root, "firstseen");
    const scratchDir = join(root, "status");
    mkdirSync(scratchDir, { recursive: true });
    writeFileSync(
      join(scratchDir, "leaf-a.json"),
      JSON.stringify({
        agent_id: "leaf-a",
        parent_id: "p",
        last_heartbeat_at: "2026-10-03T12:29:00Z",
        last_message: "watching",
        phase: "polling",
        wait_kind: "pr:watch",
      }),
      "utf8",
    );

    // Steer written ~20 min earlier, still within 30m TTL.
    writeSteer(steerDir, {
      agentId: "leaf-a",
      writerKind: "dispatching-parent",
      writerId: "parent-1",
      kind: "note",
      text: "status: are you armed on pr:watch?",
      steerId: "steer-aged",
      writtenAt: new Date("2026-10-03T12:10:00Z"),
      ttlSeconds: 1800,
      parentId: "parent-1",
    });

    const firstProbe = new Date("2026-10-03T12:30:00Z");
    const early = evaluatePreCancel({
      agentId: "leaf-a",
      cancellerId: "parent-1",
      steerDir,
      firstSeenDir,
      scratchDir,
      now: firstProbe,
      observedWindowSeconds: 180,
    });
    expect(early.ok).toBe(false);
    expect(early.refuse_reason).toBe("observed-window-incomplete");
    expect(early.first_seen_at).toBe("2026-10-03T12:30:00Z");

    const afterWindow = evaluatePreCancel({
      agentId: "leaf-a",
      cancellerId: "parent-1",
      steerDir,
      firstSeenDir,
      scratchDir,
      now: new Date("2026-10-03T12:33:00Z"),
      observedWindowSeconds: 180,
    });
    expect(afterWindow.ok).toBe(true);
    expect(afterWindow.clear_reason).toBe("steer-observed-window");
    expect(afterWindow.first_seen_at).toBe("2026-10-03T12:30:00Z");
  });

  it("DCR (iv) ack arm: matching ack clears even when pending[] is empty (PA-20)", () => {
    const root = tempRoot("pre-cancel-ack-");
    const steerDir = join(root, "inbox");
    const firstSeenDir = join(root, "firstseen");
    const scratchDir = join(root, "status");
    mkdirSync(scratchDir, { recursive: true });
    writeFileSync(
      join(scratchDir, "leaf-a.json"),
      JSON.stringify({
        agent_id: "leaf-a",
        parent_id: "p",
        last_heartbeat_at: "2026-10-03T12:00:00Z",
        last_message: "ok",
        phase: "implementing",
      }),
      "utf8",
    );
    writeSteer(steerDir, {
      agentId: "leaf-a",
      writerKind: "dispatching-parent",
      writerId: "parent-1",
      kind: "correction",
      text: "report current_step",
      steerId: "steer-ack",
      writtenAt: new Date("2026-10-03T12:00:00Z"),
      parentId: "parent-1",
    });
    ackSteer(steerDir, "leaf-a", "steer-ack", new Date("2026-10-03T12:00:30Z"));
    expect(sweepSteerPending(steerDir, { now: new Date("2026-10-03T12:01:00Z") }).pending).toEqual(
      [],
    );

    const verdict = evaluatePreCancel({
      agentId: "leaf-a",
      cancellerId: "parent-1",
      steerDir,
      firstSeenDir,
      scratchDir,
      now: new Date("2026-10-03T12:01:00Z"),
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.clear_reason).toBe("steer-acked");
  });

  it("DCR (iii): within-grace missing heartbeat does not clear; grace-expired may clear", () => {
    const root = tempRoot("pre-cancel-grace-");
    const steerDir = join(root, "inbox");
    const firstSeenDir = join(root, "firstseen");
    const scratchDir = join(root, "status");
    mkdirSync(steerDir, { recursive: true });
    mkdirSync(scratchDir, { recursive: true });

    const within = evaluatePreCancel({
      agentId: "leaf-a",
      cancellerId: "parent-1",
      steerDir,
      firstSeenDir,
      scratchDir,
      now: new Date("2026-10-03T12:02:00Z"),
      dispatchStartedAt: "2026-10-03T12:00:00Z",
      startupGraceSeconds: 180,
    });
    expect(within.ok).toBe(false);
    expect(within.refuse_reason).toBe("heartbeat-within-grace");

    const expired = evaluatePreCancel({
      agentId: "leaf-a",
      cancellerId: "parent-1",
      steerDir,
      firstSeenDir,
      scratchDir,
      now: new Date("2026-10-03T12:05:00Z"),
      dispatchStartedAt: "2026-10-03T12:00:00Z",
      startupGraceSeconds: 180,
    });
    expect(expired.ok).toBe(true);
    expect(expired.clear_reason).toBe("heartbeat-grace-expired-missing");
  });

  it("DCR (v): approach1-arm-startup halt after 3m red probe", () => {
    const within = evaluateApproach1ArmStartup({
      dispatchStartedAt: "2026-10-03T12:00:00Z",
      probeReady: false,
      now: new Date("2026-10-03T12:02:00Z"),
    });
    expect(within.halt).toBe(false);

    const halted = evaluateApproach1ArmStartup({
      dispatchStartedAt: "2026-10-03T12:00:00Z",
      probeReady: false,
      now: new Date("2026-10-03T12:03:01Z"),
    });
    expect(halted.halt).toBe(true);
    expect(halted.halt_class).toBe("approach1-arm-startup");
  });

  it("fresh malformed heartbeat refuses cancel (does not clear)", () => {
    const root = tempRoot("pre-cancel-malformed-hb-");
    const steerDir = join(root, "inbox");
    const firstSeenDir = join(root, "firstseen");
    const scratchDir = join(root, "status");
    mkdirSync(steerDir, { recursive: true });
    mkdirSync(scratchDir, { recursive: true });
    writeFileSync(
      join(scratchDir, "leaf-a.json"),
      JSON.stringify({
        agent_id: "leaf-a",
        parent_id: "p",
        last_heartbeat_at: "2026-10-03T12:00:00Z",
        last_message: "ok",
        phase: "polling",
        wait_kind: "not-a-real-kind",
      }),
      "utf8",
    );

    const verdict = evaluatePreCancel({
      agentId: "leaf-a",
      cancellerId: "parent-1",
      steerDir,
      firstSeenDir,
      scratchDir,
      now: new Date("2026-10-03T12:01:00Z"),
      dispatchStartedAt: "2026-10-03T11:00:00Z",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.refuse_reason).toBe("heartbeat-malformed");
  });

  it("STALE heartbeat clears even while status-steer observed window is incomplete", () => {
    const root = tempRoot("pre-cancel-stale-during-window-");
    const steerDir = join(root, "inbox");
    const firstSeenDir = join(root, "firstseen");
    const scratchDir = join(root, "status");
    mkdirSync(scratchDir, { recursive: true });
    writeFileSync(
      join(scratchDir, "leaf-a.json"),
      JSON.stringify({
        agent_id: "leaf-a",
        parent_id: "p",
        last_heartbeat_at: "2026-10-03T11:00:00Z",
        last_message: "gone",
        phase: "polling",
      }),
      "utf8",
    );
    writeSteer(steerDir, {
      agentId: "leaf-a",
      writerKind: "dispatching-parent",
      writerId: "parent-1",
      kind: "note",
      text: "status?",
      steerId: "steer-stale-window",
      writtenAt: new Date("2026-10-03T12:29:00Z"),
      parentId: "parent-1",
    });

    const verdict = evaluatePreCancel({
      agentId: "leaf-a",
      cancellerId: "parent-1",
      steerDir,
      firstSeenDir,
      scratchDir,
      now: new Date("2026-10-03T12:30:00Z"),
      observedWindowSeconds: 180,
      thresholdMinutes: 30,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.clear_reason).toBe("heartbeat-stale-or-missing-after-first");
  });

  it("DCR (vi): wait_kind closed validation on heartbeat", () => {
    const root = tempRoot("wait-kind-");
    const path = join(root, "leaf-a.json");
    writeFileSync(
      path,
      JSON.stringify({
        agent_id: "leaf-a",
        parent_id: "p",
        last_heartbeat_at: "2026-10-03T12:00:00Z",
        last_message: "ok",
        phase: "polling",
        wait_kind: "pr:watch",
        head_sha: "abc123",
      }),
      "utf8",
    );
    const ok = parseHeartbeatFile(path, {
      now: new Date("2026-10-03T12:01:00Z"),
      thresholdSeconds: 1800,
    });
    expect(ok.failures).toEqual([]);
    expect(ok.wait_kind).toBe("pr:watch");
    expect(ok.head_sha).toBe("abc123");

    writeFileSync(
      path,
      JSON.stringify({
        agent_id: "leaf-a",
        parent_id: "p",
        last_heartbeat_at: "2026-10-03T12:00:00Z",
        last_message: "ok",
        phase: "polling",
        wait_kind: "vibes",
      }),
      "utf8",
    );
    const bad = parseHeartbeatFile(path, {
      now: new Date("2026-10-03T12:01:00Z"),
      thresholdSeconds: 1800,
    });
    expect(bad.failures.some((f) => f.includes("wait_kind"))).toBe(true);
  });

  it("force requires reason; wrong canceller does not clear via pending", () => {
    const root = tempRoot("pre-cancel-force-");
    const steerDir = join(root, "inbox");
    const firstSeenDir = join(root, "firstseen");
    const scratchDir = join(root, "status");
    mkdirSync(scratchDir, { recursive: true });
    writeFileSync(
      join(scratchDir, "leaf-a.json"),
      JSON.stringify({
        agent_id: "leaf-a",
        parent_id: "p",
        last_heartbeat_at: "2026-10-03T12:00:00Z",
        last_message: "ok",
        phase: "implementing",
      }),
      "utf8",
    );
    writeSteer(steerDir, {
      agentId: "leaf-a",
      writerKind: "dispatching-parent",
      writerId: "parent-1",
      kind: "note",
      text: "status?",
      steerId: "steer-1",
      writtenAt: new Date("2026-10-03T11:00:00Z"),
      parentId: "parent-1",
    });

    const wrongWriter = evaluatePreCancel({
      agentId: "leaf-a",
      cancellerId: "other-parent",
      steerDir,
      firstSeenDir,
      scratchDir,
      now: new Date("2026-10-03T12:00:00Z"),
      observedWindowSeconds: 1,
    });
    expect(wrongWriter.ok).toBe(false);

    const noReason = evaluatePreCancel({
      agentId: "leaf-a",
      cancellerId: "parent-1",
      steerDir,
      firstSeenDir,
      scratchDir,
      force: true,
      forceReason: "  ",
    });
    expect(noReason.ok).toBe(false);
    expect(noReason.exitCode).toBe(2);

    const forced = evaluatePreCancel({
      agentId: "leaf-a",
      cancellerId: "parent-1",
      steerDir,
      firstSeenDir,
      scratchDir,
      force: true,
      forceReason: "operator override",
    });
    expect(forced.ok).toBe(true);
    expect(forced.clear_reason).toBe("force");
  });
});
