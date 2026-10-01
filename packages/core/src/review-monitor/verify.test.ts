import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bindLivePhaseCorrectWait,
  evaluateMergePathArm,
  writePrWatchWaitHeartbeat,
} from "../pr-watch/main.js";
import { DEFAULT_STALE_MINUTES } from "./constants.js";
import { computeExpiresAt, renderReviewOwnerComment } from "./lease-comment.js";
import { probeMonitoringTier } from "./tier-detection.js";
import {
  evaluateReviewMonitorGate,
  formatApproach1BabysitterOneLiner,
  hasActivePollingHeartbeat,
  heartbeatActiveForMergePathArm,
  POST_CLEAN_WAIT_PARENT_ID,
  verifyResultToJson,
  writeMergePathCleanAttestation,
} from "./verify.js";

const NOW = new Date("2026-07-24T12:00:00.000Z");

function activeLeaseComment(
  owner: string,
  monitorAgentId: string,
  platformPrimitive: "cursor-task" | "spawn_subagent" = "cursor-task",
): string {
  return renderReviewOwnerComment({
    owner,
    monitor_agent_id: monitorAgentId,
    head_sha: "abc123",
    started_at: NOW.toISOString(),
    expires_at: computeExpiresAt(NOW),
    platform_primitive: platformPrimitive,
    ended_at: null,
  });
}

describe("probeMonitoringTier", () => {
  it("detects Cursor composer as Tier 1 cursor-task", () => {
    const probe = probeMonitoringTier({ CURSOR_COMPOSER: "1" });
    expect(probe.tier).toBe(1);
    expect(probe.primitive).toBe("cursor-task");
    expect(probe.descriptor).toBe("cursor-composer");
  });

  it("detects grok-build as Tier 1 spawn_subagent", () => {
    const probe = probeMonitoringTier({ GROK_BUILD: "yes" });
    expect(probe.tier).toBe(1);
    expect(probe.primitive).toBe("spawn_subagent");
  });

  it("falls through to Tier 3 with no signals", () => {
    const probe = probeMonitoringTier({});
    expect(probe.tier).toBe(3);
    expect(probe.descriptor).toBe("generic-terminal");
  });
});

describe("evaluateReviewMonitorGate", () => {
  it("Tier 1 + missing GitHub lease fails closed", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-gate-"));
    const result = evaluateReviewMonitorGate({
      pr: 42,
      projectRoot: root,
      repo: "deftai/directive",
      callSite: "solo",
      environ: { CURSOR_COMPOSER: "1" },
      seams: { fetchComments: () => [] },
    });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("no active GitHub review-owner lease");
    expect(result.message).toContain("review-monitor:register");
  });

  it("Tier 1 + GitHub lease passes", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-gate-ok-"));
    const result = evaluateReviewMonitorGate({
      pr: 7,
      projectRoot: root,
      repo: "deftai/directive",
      headSha: "abc123",
      callSite: "swarm-phase5-6",
      now: NOW,
      environ: { CURSOR_COMPOSER: "1" },
      seams: {
        fetchComments: () => [
          {
            id: 7,
            body: activeLeaseComment("alice", "review-monitor-pr-7"),
            htmlUrl: "",
            updatedAt: "2026-07-24T12:00:00.000Z",
            authorLogin: "alice",
            authorAssociation: "MEMBER",
          },
        ],
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.monitorRecord?.monitor_agent_id).toBe("review-monitor-pr-7");
  });

  it("legacy local JSON alone does not satisfy Tier 1 gate", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-gate-local-"));
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(
      join(root, ".deft", "review-monitor.json"),
      JSON.stringify({
        schema_version: 1,
        records: [
          {
            pr: 8,
            monitor_agent_id: "legacy-only",
            platform_primitive: "cursor-task",
            started_at: new Date().toISOString(),
            worktree_path: root,
          },
        ],
      }),
      "utf8",
    );
    const result = evaluateReviewMonitorGate({
      pr: 8,
      projectRoot: root,
      repo: "deftai/directive",
      environ: { CURSOR_COMPOSER: "1" },
      seams: { fetchComments: () => [] },
    });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("Legacy .deft/review-monitor.json is ignored");
  });

  it("Tier 3 allows verify without monitor record", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-gate-t3-"));
    const result = evaluateReviewMonitorGate({
      pr: 99,
      projectRoot: root,
      environ: {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("Tier 3");
    expect(result.tier.descriptor).toBe("generic-terminal");
  });

  it("labels DEFT_MONITOR_TIER=3 READY distinctly from honest generic-terminal (#5229)", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-gate-override-t3-"));
    const result = evaluateReviewMonitorGate({
      pr: 99,
      projectRoot: root,
      environ: { DEFT_MONITOR_TIER: "3" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.tier.descriptor).toBe("override-tier3");
    expect(result.message).toContain("override-tier3");
    expect(result.message).toContain("not honest generic-terminal");
  });

  it("!isTier1 consults sticky lease before READY and elevates on Tier-1 primitive (#5229)", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-gate-lease-elevate-"));
    const result = evaluateReviewMonitorGate({
      pr: 5229,
      projectRoot: root,
      repo: "deftai/directive",
      headSha: "abc123",
      now: NOW,
      environ: {},
      seams: {
        fetchComments: () => [
          {
            id: 5229,
            body: activeLeaseComment("owner", "babysitter-5229", "spawn_subagent"),
            htmlUrl: "",
            updatedAt: "2026-07-24T12:00:00.000Z",
            authorLogin: "owner",
            authorAssociation: "MEMBER",
          },
        ],
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.tier.descriptor).toBe("lease-elevated");
    expect(result.tier.primitive).toBe("spawn_subagent");
    expect(result.monitorRecord?.monitor_agent_id).toBe("babysitter-5229");
    expect(result.message).toContain("elevated via sticky lease");
    expect(result.message).not.toContain("no active review-monitor required");
  });

  it("rejects Approach 3 on Tier 1", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-gate-a3-"));
    const result = evaluateReviewMonitorGate({
      pr: 1,
      projectRoot: root,
      repo: "deftai/directive",
      approach3: true,
      environ: { CURSOR_COMPOSER: "1" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("Approach 3 blocking poll is forbidden");
  });

  it("Claude Tier-1 redirect leads with leaf-safe ownership (#3134)", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-gate-claude-leaf-"));
    const result = evaluateReviewMonitorGate({
      pr: 42,
      projectRoot: root,
      repo: "deftai/directive",
      approach3: true,
      environ: { DEFT_PROBE_CLAUDE_CODE: "1" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("claude-agent");
    expect(result.message).toContain("Ownership path for claude-agent");
    expect(result.message).toContain("Do NOT nested-spawn");
    expect(result.message).toContain("blocking dual-invoke `pr:watch`");
    // Leaf-safe path must appear before the top-level spawn instruction.
    const leafIdx = result.message.indexOf("Implementation leaf");
    const spawnIdx = result.message.indexOf("Top-level parent");
    expect(leafIdx).toBeGreaterThanOrEqual(0);
    expect(spawnIdx).toBeGreaterThan(leafIdx);
  });

  it("Grok Bot Tier-1 redirect cites #4201 leaf-safe ownership", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-gate-grok-bot-leaf-"));
    const result = evaluateReviewMonitorGate({
      pr: 43,
      projectRoot: root,
      repo: "deftai/directive",
      approach3: true,
      environ: { DEFT_PROBE_GROK_BOT: "1" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("grok-bot-executor");
    expect(result.message).toContain("Ownership path for grok-bot-executor (#4201)");
    expect(result.message).toContain("Do NOT nested-spawn");
  });

  it("allows Approach 3 on Tier 3 with warning ack", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-gate-a3ok-"));
    const result = evaluateReviewMonitorGate({
      pr: 1,
      projectRoot: root,
      approach3: true,
      approach3Warned: true,
      environ: {},
    });
    expect(result.exitCode).toBe(0);
  });

  it("rejects Approach 3 when sticky Tier-1 lease exists despite bare env (#5229)", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-gate-a3-lease-"));
    const result = evaluateReviewMonitorGate({
      pr: 5229,
      projectRoot: root,
      repo: "deftai/directive",
      headSha: "abc123",
      approach3: true,
      approach3Warned: true,
      now: NOW,
      environ: {},
      seams: {
        fetchComments: () => [
          {
            id: 5229,
            body: activeLeaseComment("owner", "babysitter-5229", "spawn_subagent"),
            htmlUrl: "",
            updatedAt: "2026-07-24T12:00:00.000Z",
            authorLogin: "owner",
            authorAssociation: "MEMBER",
          },
        ],
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.tier.descriptor).toBe("lease-elevated");
    expect(result.message).toContain("Approach 3 blocking poll is forbidden");
  });

  it("rejects Approach 3 on Tier 3 without warning ack", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-gate-a3warn-"));
    const result = evaluateReviewMonitorGate({
      pr: 1,
      projectRoot: root,
      approach3: true,
      approach3Warned: false,
      environ: {},
    });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("approach3-warned");
  });

  it("exits config error for missing project root", () => {
    const result = evaluateReviewMonitorGate({
      pr: 1,
      projectRoot: join(tmpdir(), "rm-missing-root-does-not-exist"),
      environ: {},
    });
    expect(result.exitCode).toBe(2);
  });

  it("serializes verifyResultToJson", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-gate-json-"));
    const result = evaluateReviewMonitorGate({
      pr: 3,
      projectRoot: root,
      environ: {},
    });
    const json = verifyResultToJson(result);
    expect(json.ready).toBe(true);
    expect(json.exit_code).toBe(0);
    expect(json.tier).toBe(3);
  });

  it("fails when GitHub lease head_sha mismatches", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-gate-sha-"));
    const result = evaluateReviewMonitorGate({
      pr: 8,
      projectRoot: root,
      repo: "deftai/directive",
      headSha: "bbbb",
      now: NOW,
      environ: { CURSOR_COMPOSER: "1" },
      seams: {
        fetchComments: () => [
          {
            id: 8,
            body: activeLeaseComment("alice", "rm-8"),
            htmlUrl: "",
            updatedAt: "2026-07-24T12:00:00.000Z",
            authorLogin: "alice",
            authorAssociation: "MEMBER",
          },
        ],
      },
    });
    expect(result.exitCode).toBe(1);
  });

  it("includes solo call-site hint when failing closed", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-gate-solo-"));
    const result = evaluateReviewMonitorGate({
      pr: 2,
      projectRoot: root,
      repo: "deftai/directive",
      callSite: "solo",
      environ: { CURSOR_COMPOSER: "1" },
      seams: { fetchComments: () => [] },
    });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("Solo drive-to");
  });

  it("Tier 2 does not require a monitor record", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-gate-t2-"));
    const result = evaluateReviewMonitorGate({
      pr: 3,
      projectRoot: root,
      environ: { DEFT_MONITOR_TIER2: "1" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("Tier 2");
  });

  it("hasActivePollingHeartbeat ignores missing or non-dir status paths", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-hb-miss-"));
    expect(hasActivePollingHeartbeat(root, 1)).toBe(false);
    mkdirSync(join(root, ".deft-scratch"), { recursive: true });
    writeFileSync(join(root, ".deft-scratch", "subagent-status"), "not-a-dir", "utf8");
    expect(hasActivePollingHeartbeat(root, 1)).toBe(false);
  });

  it("heartbeat alone does not satisfy Tier 1 verify (#2814)", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-gate-hb-"));
    const statusDir = join(root, ".deft-scratch", "subagent-status");
    mkdirSync(statusDir, { recursive: true });
    writeFileSync(
      join(statusDir, "poller-pr-55.json"),
      JSON.stringify({
        agent_id: "poller-pr-55",
        parent_id: "parent-1",
        last_heartbeat_at: new Date().toISOString(),
        last_message: "polling",
        phase: "polling",
        terminal_state: null,
        pr_number: 55,
      }),
      "utf8",
    );
    expect(hasActivePollingHeartbeat(root, 55)).toBe(true);
    const result = evaluateReviewMonitorGate({
      pr: 55,
      projectRoot: root,
      repo: "deftai/directive",
      callSite: "swarm-phase6-cascade",
      environ: { CURSOR_COMPOSER: "1" },
      seams: { fetchComments: () => [] },
    });
    expect(result.exitCode).toBe(1);
    expect(result.heartbeatActive).toBe(true);
    expect(result.message).toContain("local subagent heartbeat is present");
  });

  it("wait exit while lease sticky leaves --merge-path-arm --live-wait unarmed (#5020)", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-dead-wait-"));
    writePrWatchWaitHeartbeat(root, 5020, { phase: "polling" });
    expect(hasActivePollingHeartbeat(root, 5020)).toBe(true);
    writePrWatchWaitHeartbeat(root, 5020, { phase: "terminal", terminalState: "exited" });
    expect(hasActivePollingHeartbeat(root, 5020)).toBe(false);

    const result = evaluateReviewMonitorGate({
      pr: 5020,
      projectRoot: root,
      repo: "deftai/directive",
      callSite: "solo",
      environ: { GROK_BUILD: "1" },
      seams: {
        fetchComments: () => [
          {
            id: 1,
            body: activeLeaseComment("owner", "monitor-5020"),
            htmlUrl: "",
            updatedAt: NOW.toISOString(),
            authorLogin: "owner",
            authorAssociation: "MEMBER",
          },
        ],
      },
      now: NOW,
    });
    expect(result.exitCode).toBe(0);
    expect(result.monitorRecord).not.toBeNull();
    expect(result.heartbeatActive).toBe(false);

    const liveBind = bindLivePhaseCorrectWait({
      liveWaitFlag: true,
      tierIs1: true,
      leaseEvidence: result.monitorRecord !== null,
      heartbeatActive: result.heartbeatActive,
      pr: 5020,
    });
    expect(liveBind.livePhaseCorrectWait).toBe(false);
    expect(liveBind.reason).toBe("missing_process_liveness");
    const arm = evaluateMergePathArm({
      livePhaseCorrectWait: liveBind.livePhaseCorrectWait,
      explicitFinish: false,
      stickyLeaseActive: true,
    });
    expect(arm.armed).toBe(false);
  });

  it("force-killed wait (fresh file, dead pid) leaves --live-wait unarmed (#5020)", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-force-kill-"));
    const deadPid = 9_999_992;
    writePrWatchWaitHeartbeat(root, 5020, { phase: "polling", pid: deadPid });
    // finally never ran; pid liveness still refuses the arm.
    expect(
      hasActivePollingHeartbeat(root, 5020, {
        isProcessAlive: () => false,
      }),
    ).toBe(false);

    const result = evaluateReviewMonitorGate({
      pr: 5020,
      projectRoot: root,
      repo: "deftai/directive",
      callSite: "solo",
      environ: { GROK_BUILD: "1" },
      seams: {
        fetchComments: () => [
          {
            id: 1,
            body: activeLeaseComment("owner", "monitor-5020"),
            htmlUrl: "",
            updatedAt: NOW.toISOString(),
            authorLogin: "owner",
            authorAssociation: "MEMBER",
          },
        ],
      },
      now: NOW,
    });
    // Gate uses real process.kill; deadPid is almost certainly not alive.
    expect(result.heartbeatActive).toBe(false);
    const liveBind = bindLivePhaseCorrectWait({
      liveWaitFlag: true,
      tierIs1: true,
      leaseEvidence: true,
      heartbeatActive: result.heartbeatActive,
      pr: 5020,
    });
    expect(liveBind.livePhaseCorrectWait).toBe(false);
    expect(liveBind.reason).toBe("missing_process_liveness");
  });

  it("DEFAULT_STALE_MINUTES remains abandonment hygiene, not wait liveness (#5020)", () => {
    expect(DEFAULT_STALE_MINUTES).toBe(30);
    // Dead-wait unarm is heartbeat/process-liveness, not TTL expiry.
    const bound = bindLivePhaseCorrectWait({
      liveWaitFlag: true,
      tierIs1: true,
      leaseEvidence: true,
      heartbeatActive: false,
      pr: 1,
    });
    expect(bound.reason).toBe("missing_process_liveness");
  });

  it("spawn_subagent: parent-shell pr:watch does not satisfy child-bound live-wait (#5219)", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-5219-parent-shell-"));
    writePrWatchWaitHeartbeat(root, 5219, { phase: "polling" }); // parent_id=pr-watch
    expect(hasActivePollingHeartbeat(root, 5219)).toBe(true);

    const result = evaluateReviewMonitorGate({
      pr: 5219,
      projectRoot: root,
      repo: "deftai/directive",
      callSite: "solo",
      environ: { GROK_BUILD: "1" },
      seams: {
        fetchComments: () => [
          {
            id: 1,
            body: activeLeaseComment("owner", "babysitter-5219", "spawn_subagent"),
            htmlUrl: "",
            updatedAt: NOW.toISOString(),
            authorLogin: "owner",
            authorAssociation: "MEMBER",
          },
        ],
      },
      now: NOW,
    });
    expect(result.exitCode).toBe(0);
    expect(result.monitorRecord?.platform_primitive).toBe("spawn_subagent");
    expect(result.heartbeatActive).toBe(false);

    const liveBind = bindLivePhaseCorrectWait({
      liveWaitFlag: true,
      tierIs1: true,
      leaseEvidence: true,
      heartbeatActive: result.heartbeatActive,
      pr: 5219,
    });
    expect(liveBind.livePhaseCorrectWait).toBe(false);
    expect(liveBind.reason).toBe("missing_process_liveness");
    expect(
      evaluateMergePathArm({
        livePhaseCorrectWait: liveBind.livePhaseCorrectWait,
        explicitFinish: false,
        stickyLeaseActive: true,
      }).armed,
    ).toBe(false);
  });

  it("spawn_subagent: unrelated same-PR parent heartbeat does not join (#5219)", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-5219-unrelated-"));
    writePrWatchWaitHeartbeat(root, 5219, {
      phase: "polling",
      parentId: "some-other-agent",
      pid: 4_001,
    });
    expect(
      hasActivePollingHeartbeat(root, 5219, {
        expectedParentIds: ["babysitter-5219", POST_CLEAN_WAIT_PARENT_ID],
      }),
    ).toBe(false);
  });

  it("spawn_subagent: dead child + live parent shell stays unarmed (#5219)", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-5219-dead-child-"));
    const deadPid = 9_999_991;
    const lease = {
      pr: 5219,
      repo: "deftai/directive" as string | null,
      head_sha: "abc" as string | null,
      platform_primitive: "spawn_subagent" as const,
      monitor_agent_id: "babysitter-5219",
      owner: "owner",
      started_at: NOW.toISOString(),
      expires_at: computeExpiresAt(NOW),
      worktree_path: null as string | null,
      parent_session_id: null as string | null,
      ended_at: null as string | null,
      comment_id: 1 as number | null,
    };
    writePrWatchWaitHeartbeat(root, 5219, {
      phase: "polling",
      parentId: "babysitter-5219",
      pid: deadPid,
    });
    writePrWatchWaitHeartbeat(root, 5219, {
      phase: "polling",
      parentId: "pr-watch",
      pid: 4_002,
    });
    expect(
      heartbeatActiveForMergePathArm(root, 5219, {
        tierPrimitive: "spawn_subagent",
        lease,
        isProcessAlive: (pid) => pid !== deadPid,
      }),
    ).toBe(false);
  });

  it("spawn_subagent: matching live child arms (#5219)", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-5219-child-"));
    const lease = {
      pr: 5219,
      repo: "deftai/directive" as string | null,
      head_sha: "abc" as string | null,
      platform_primitive: "spawn_subagent" as const,
      monitor_agent_id: "babysitter-5219",
      owner: "owner",
      started_at: NOW.toISOString(),
      expires_at: computeExpiresAt(NOW),
      worktree_path: null as string | null,
      parent_session_id: null as string | null,
      ended_at: null as string | null,
      comment_id: 1 as number | null,
    };
    writePrWatchWaitHeartbeat(root, 5219, {
      phase: "polling",
      parentId: "babysitter-5219",
      pid: 4_003,
    });
    const childOk = heartbeatActiveForMergePathArm(root, 5219, {
      tierPrimitive: "spawn_subagent",
      lease,
      isProcessAlive: () => true,
    });
    expect(childOk).toBe(true);
  });

  it("spawn_subagent: closer without CLEAN attestation stays unarmed (#5219)", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-5219-premature-closer-"));
    const lease = {
      pr: 5219,
      repo: "deftai/directive" as string | null,
      head_sha: "abc" as string | null,
      platform_primitive: "spawn_subagent" as const,
      monitor_agent_id: "babysitter-5219",
      owner: "owner",
      started_at: NOW.toISOString(),
      expires_at: computeExpiresAt(NOW),
      worktree_path: null as string | null,
      parent_session_id: null as string | null,
      ended_at: null as string | null,
      comment_id: 1 as number | null,
    };
    writePrWatchWaitHeartbeat(root, 5219, {
      phase: "polling",
      parentId: POST_CLEAN_WAIT_PARENT_ID,
      pid: 4_004,
    });
    expect(
      heartbeatActiveForMergePathArm(root, 5219, {
        tierPrimitive: "spawn_subagent",
        lease,
        isProcessAlive: () => true,
        headSha: "abc",
      }),
    ).toBe(false);
  });

  it("spawn_subagent: post-CLEAN wait-merge heartbeat arms with attestation (#5219)", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-5219-postclean-"));
    const lease = {
      pr: 5219,
      repo: "deftai/directive" as string | null,
      head_sha: "abc" as string | null,
      platform_primitive: "spawn_subagent" as const,
      monitor_agent_id: "babysitter-5219",
      owner: "owner",
      started_at: NOW.toISOString(),
      expires_at: computeExpiresAt(NOW),
      worktree_path: null as string | null,
      parent_session_id: null as string | null,
      ended_at: null as string | null,
      comment_id: 1 as number | null,
    };
    expect(writeMergePathCleanAttestation(root, 5219, "abc", NOW).ok).toBe(true);
    writePrWatchWaitHeartbeat(root, 5219, {
      phase: "polling",
      parentId: POST_CLEAN_WAIT_PARENT_ID,
      pid: 4_005,
    });
    expect(
      heartbeatActiveForMergePathArm(root, 5219, {
        tierPrimitive: "spawn_subagent",
        lease,
        isProcessAlive: () => true,
        headSha: "abc",
        resolveLiveHeadSha: () => "abc",
      }),
    ).toBe(true);
  });

  it("spawn_subagent: tip-A CLEAN attestation does not arm tip-B closer (#5219)", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-5219-stale-clean-"));
    const lease = {
      pr: 5219,
      repo: "deftai/directive" as string | null,
      head_sha: "tip-b" as string | null,
      platform_primitive: "spawn_subagent" as const,
      monitor_agent_id: "babysitter-5219",
      owner: "owner",
      started_at: NOW.toISOString(),
      expires_at: computeExpiresAt(NOW),
      worktree_path: null as string | null,
      parent_session_id: null as string | null,
      ended_at: null as string | null,
      comment_id: 1 as number | null,
    };
    expect(writeMergePathCleanAttestation(root, 5219, "tip-a", NOW).ok).toBe(true);
    writePrWatchWaitHeartbeat(root, 5219, {
      phase: "polling",
      parentId: POST_CLEAN_WAIT_PARENT_ID,
      pid: 4_006,
    });
    expect(
      heartbeatActiveForMergePathArm(root, 5219, {
        tierPrimitive: "spawn_subagent",
        lease,
        isProcessAlive: () => true,
        headSha: "tip-a",
        resolveLiveHeadSha: () => "tip-b",
      }),
    ).toBe(false);
    expect(
      heartbeatActiveForMergePathArm(root, 5219, {
        tierPrimitive: "spawn_subagent",
        lease,
        isProcessAlive: () => true,
        headSha: "tip-a",
        resolveLiveHeadSha: () => null,
      }),
    ).toBe(false);
  });

  it("spawn_subagent: child heartbeat skips live HEAD lookup (#5219 P2)", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-5219-no-lookup-"));
    const lease = {
      pr: 5219,
      repo: "deftai/directive" as string | null,
      head_sha: "abc" as string | null,
      platform_primitive: "spawn_subagent" as const,
      monitor_agent_id: "babysitter-5219",
      owner: "owner",
      started_at: NOW.toISOString(),
      expires_at: computeExpiresAt(NOW),
      worktree_path: null as string | null,
      parent_session_id: null as string | null,
      ended_at: null as string | null,
      comment_id: 1 as number | null,
    };
    writePrWatchWaitHeartbeat(root, 5219, {
      phase: "polling",
      parentId: "babysitter-5219",
      pid: 4_007,
    });
    let lookedUp = 0;
    expect(
      heartbeatActiveForMergePathArm(root, 5219, {
        tierPrimitive: "spawn_subagent",
        lease,
        isProcessAlive: () => true,
        resolveLiveHeadSha: () => {
          lookedUp += 1;
          return "should-not-run";
        },
      }),
    ).toBe(true);
    expect(lookedUp).toBe(0);
  });

  it("formatApproach1BabysitterOneLiner watches before parent verify (#5219 P3)", () => {
    const text = formatApproach1BabysitterOneLiner(9, "rm-9");
    expect(text).toContain("DEFT_MONITOR_AGENT_ID=rm-9");
    expect(text).toContain("--monitor-agent-id rm-9");
    const watchAt = text.indexOf("pr:watch -- 9");
    const verifyAt = text.indexOf("verify:review-monitor");
    expect(watchAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeGreaterThan(watchAt);
  });
});
