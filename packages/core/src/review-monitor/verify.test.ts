import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findActiveMonitorForPr,
  readReviewMonitorFile,
  registerReviewMonitor,
  reviewMonitorPath,
} from "./record.js";
import { probeMonitoringTier } from "./tier-detection.js";
import {
  evaluateReviewMonitorGate,
  hasActivePollingHeartbeat,
  verifyResultToJson,
} from "./verify.js";

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
  it("Tier 1 + missing record fails closed", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-gate-"));
    const result = evaluateReviewMonitorGate({
      pr: 42,
      projectRoot: root,
      callSite: "solo",
      environ: { CURSOR_COMPOSER: "1" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("no active review-monitor");
    expect(result.message).toContain("review-monitor:register");
  });

  it("Tier 1 + valid record passes", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-gate-ok-"));
    registerReviewMonitor({
      pr: 7,
      platformPrimitive: "cursor-task",
      monitorAgentId: "review-monitor-pr-7",
      projectRoot: root,
      headSha: "abc123",
    });
    const result = evaluateReviewMonitorGate({
      pr: 7,
      projectRoot: root,
      headSha: "abc123",
      callSite: "swarm-phase5-6",
      environ: { CURSOR_AGENT: "1" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.monitorRecord?.monitor_agent_id).toBe("review-monitor-pr-7");
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
      approach3: true,
      environ: { CURSOR_COMPOSER: "1" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("Approach 3 blocking poll is forbidden");
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

  it("fails when monitor head_sha mismatches", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-gate-sha-"));
    registerReviewMonitor({
      pr: 8,
      platformPrimitive: "cursor-task",
      monitorAgentId: "rm-8",
      projectRoot: root,
      headSha: "aaaa",
    });
    const result = evaluateReviewMonitorGate({
      pr: 8,
      projectRoot: root,
      headSha: "bbbb",
      environ: { CURSOR_COMPOSER: "1" },
    });
    expect(result.exitCode).toBe(1);
  });

  it("exits config error when review-monitor file is corrupt", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-gate-corrupt-"));
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(join(root, ".deft", "review-monitor.json"), "{bad", "utf8");
    const result = evaluateReviewMonitorGate({
      pr: 1,
      projectRoot: root,
      environ: { CURSOR_COMPOSER: "1" },
    });
    expect(result.exitCode).toBe(2);
  });

  it("includes solo call-site hint when failing closed", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-gate-solo-"));
    const result = evaluateReviewMonitorGate({
      pr: 2,
      projectRoot: root,
      callSite: "solo",
      environ: { CURSOR_COMPOSER: "1" },
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

  it("accepts active polling heartbeat as monitor evidence", () => {
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
      callSite: "swarm-phase6-cascade",
      environ: { CURSOR_COMPOSER: "1" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.heartbeatActive).toBe(true);
  });
});

describe("review monitor record file", () => {
  it("round-trips register and read", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-rec-"));
    registerReviewMonitor({
      pr: 12,
      platformPrimitive: "spawn_subagent",
      monitorAgentId: "rm-12",
      projectRoot: root,
      repo: "deftai/directive",
    });
    const path = reviewMonitorPath(root);
    const { data } = readReviewMonitorFile(path);
    expect(data?.records).toHaveLength(1);
    const active = findActiveMonitorForPr(data as NonNullable<typeof data>, 12, {});
    expect(active?.monitor_agent_id).toBe("rm-12");
  });
});
