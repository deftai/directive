import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeExpiresAt, renderReviewOwnerComment } from "./lease-comment.js";
import { probeMonitoringTier } from "./tier-detection.js";
import {
  evaluateReviewMonitorGate,
  hasActivePollingHeartbeat,
  verifyResultToJson,
} from "./verify.js";

const NOW = new Date("2026-07-24T12:00:00.000Z");

function activeLeaseComment(owner: string, monitorAgentId: string): string {
  return renderReviewOwnerComment({
    owner,
    monitor_agent_id: monitorAgentId,
    head_sha: "abc123",
    started_at: NOW.toISOString(),
    expires_at: computeExpiresAt(NOW),
    platform_primitive: "cursor-task",
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
});
