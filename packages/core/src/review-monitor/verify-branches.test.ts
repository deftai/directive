import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerReviewMonitor } from "./record.js";
import {
  evaluateReviewMonitorGate,
  hasActivePollingHeartbeat,
  verifyResultToJson,
} from "./verify.js";

describe("review-monitor verify branch coverage (#2666)", () => {
  it("includes swarm-phase5-6 call-site hint when failing closed on Tier 1", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-cs-p56-"));
    const result = evaluateReviewMonitorGate({
      pr: 11,
      projectRoot: root,
      callSite: "swarm-phase5-6",
      environ: { CURSOR_COMPOSER: "1" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("Swarm Phase 5→6 handoff");
  });

  it("includes swarm-phase6-cascade call-site hint when failing closed on Tier 1", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-cs-p6c-"));
    const result = evaluateReviewMonitorGate({
      pr: 12,
      projectRoot: root,
      callSite: "swarm-phase6-cascade",
      environ: { CURSOR_COMPOSER: "1" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("Swarm Phase 6 post force-push");
  });

  it("verifyResultToJson surfaces monitor_agent_id from an active record", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-json-agent-"));
    registerReviewMonitor({
      pr: 21,
      platformPrimitive: "cursor-task",
      monitorAgentId: "review-monitor-pr-21",
      projectRoot: root,
    });
    const result = evaluateReviewMonitorGate({
      pr: 21,
      projectRoot: root,
      environ: { CURSOR_COMPOSER: "1" },
    });
    const json = verifyResultToJson(result);
    expect(json.monitor_agent_id).toBe("review-monitor-pr-21");
    expect(json.ready).toBe(true);
  });

  it("accepts a starting-phase polling heartbeat as monitor evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-hb-start-"));
    const statusDir = join(root, ".deft-scratch", "subagent-status");
    mkdirSync(statusDir, { recursive: true });
    writeFileSync(
      join(statusDir, "poller-pr-77.json"),
      JSON.stringify({
        agent_id: "poller-pr-77",
        parent_id: "parent-1",
        last_heartbeat_at: new Date().toISOString(),
        last_message: "starting",
        phase: "starting",
        terminal_state: null,
        pr_number: 77,
      }),
      "utf8",
    );
    expect(hasActivePollingHeartbeat(root, 77)).toBe(true);
  });
});
