import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeExpiresAt, renderReviewOwnerComment } from "./lease-comment.js";
import { registerReviewMonitor } from "./record.js";
import { evaluateReviewMonitorGate, verifyResultToJson } from "./verify.js";

const NOW = new Date("2026-07-24T12:00:00.000Z");

describe("review-monitor verify branch coverage (#2666)", () => {
  it("includes swarm-phase5-6 call-site hint when failing closed on Tier 1", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-cs-p56-"));
    const result = evaluateReviewMonitorGate({
      pr: 11,
      projectRoot: root,
      repo: "deftai/directive",
      callSite: "swarm-phase5-6",
      environ: { CURSOR_COMPOSER: "1" },
      seams: { fetchComments: () => [] },
    });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("Swarm Phase 5→6 handoff");
  });

  it("includes swarm-phase6-cascade call-site hint when failing closed on Tier 1", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-cs-p6c-"));
    const result = evaluateReviewMonitorGate({
      pr: 12,
      projectRoot: root,
      repo: "deftai/directive",
      callSite: "swarm-phase6-cascade",
      environ: { CURSOR_COMPOSER: "1" },
      seams: { fetchComments: () => [] },
    });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("Swarm Phase 6 post force-push");
  });

  it("verifyResultToJson surfaces monitor_agent_id from an active GitHub lease", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-json-agent-"));
    const body = renderReviewOwnerComment({
      owner: "alice",
      monitor_agent_id: "review-monitor-pr-21",
      head_sha: "abc",
      started_at: NOW.toISOString(),
      expires_at: computeExpiresAt(NOW),
      platform_primitive: "cursor-task",
      ended_at: null,
    });
    const result = evaluateReviewMonitorGate({
      pr: 21,
      projectRoot: root,
      repo: "deftai/directive",
      now: NOW,
      environ: { CURSOR_COMPOSER: "1" },
      seams: {
        fetchComments: () => [
          {
            id: 21,
            body,
            htmlUrl: "",
            updatedAt: NOW.toISOString(),
            authorLogin: "alice",
            authorAssociation: "MEMBER",
          },
        ],
      },
    });
    const json = verifyResultToJson(result);
    expect(json.monitor_agent_id).toBe("review-monitor-pr-21");
    expect(json.ready).toBe(true);
  });

  it("covers Approach 3 and GitHub fetch error branches", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-verify-br-"));
    expect(
      evaluateReviewMonitorGate({
        pr: 30,
        projectRoot: root,
        repo: "deftai/directive",
        approach3: true,
        environ: { CURSOR_COMPOSER: "1" },
      }).message,
    ).toContain("Approach 3 blocking poll is forbidden");

    expect(
      evaluateReviewMonitorGate({
        pr: 31,
        projectRoot: root,
        repo: "deftai/directive",
        approach3: true,
        environ: {},
      }).message,
    ).toContain("explicit user warning acknowledgment");

    expect(
      evaluateReviewMonitorGate({
        pr: 32,
        projectRoot: root,
        repo: "deftai/directive",
        approach3: true,
        approach3Warned: true,
        environ: {},
      }).exitCode,
    ).toBe(0);

    expect(
      evaluateReviewMonitorGate({
        pr: 33,
        projectRoot: root,
        repo: "deftai/directive",
        environ: { CURSOR_COMPOSER: "1" },
        seams: { fetchComments: () => ({ error: "offline" }) },
      }).exitCode,
    ).toBe(2);
  });

  it("registerReviewMonitor returns config error when repo cannot be resolved", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-reg-config-"));
    const result = registerReviewMonitor({
      pr: 3,
      platformPrimitive: "cursor-task",
      monitorAgentId: "rm-3",
      projectRoot: root,
      repo: "",
      owner: "alice",
    });
    expect(result.exitCode).toBe(2);
  });

  it("includes unspecified call-site hint when failing closed", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-cs-unspec-"));
    const result = evaluateReviewMonitorGate({
      pr: 13,
      projectRoot: root,
      repo: "deftai/directive",
      callSite: "unspecified",
      environ: { CURSOR_COMPOSER: "1" },
      seams: { fetchComments: () => [] },
    });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("Solo drive-to");
  });

  it("fails when repo cannot be resolved on Tier 1 verify", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-verify-repo-"));
    const result = evaluateReviewMonitorGate({
      pr: 4,
      projectRoot: root,
      repo: "",
      environ: { CURSOR_COMPOSER: "1" },
    });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("could not resolve owner/repo");
  });
});
