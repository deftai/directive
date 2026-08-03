import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateL4OwnerGate,
  l4OwnerResultToJson,
  parseInProgressEvidence,
  parseReviewCycleEvidence,
} from "./l4-owner.js";
import { computeExpiresAt, renderReviewOwnerComment } from "./lease-comment.js";

const NOW = new Date("2026-08-03T12:00:00.000Z");

function activeLeaseComment(owner: string, monitorAgentId: string): string {
  return renderReviewOwnerComment({
    owner,
    monitor_agent_id: monitorAgentId,
    head_sha: "abc123",
    started_at: NOW.toISOString(),
    expires_at: computeExpiresAt(NOW),
    platform_primitive: "spawn_subagent",
    ended_at: null,
  });
}

describe("parseReviewCycleEvidence (#3090)", () => {
  it("accepts enum values", () => {
    expect(parseReviewCycleEvidence("done")).toEqual({ ok: true, value: "done" });
    expect(parseReviewCycleEvidence("n/a")).toEqual({ ok: true, value: "n/a" });
    expect(parseReviewCycleEvidence("in_progress:12#monitor-a")).toEqual({
      ok: true,
      value: "in_progress:12#monitor-a",
    });
    expect(parseReviewCycleEvidence("skipped:no-pr")).toEqual({
      ok: true,
      value: "skipped:no-pr",
    });
  });

  it("rejects freeform started/pending/initiated", () => {
    for (const bad of ["started", "pending", "initiated", "START"]) {
      const r = parseReviewCycleEvidence(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("illegal freeform");
    }
  });

  it("rejects bare in_progress without pr#ref", () => {
    const r = parseReviewCycleEvidence("in_progress");
    expect(r.ok).toBe(false);
  });

  it("rejects non-numeric in_progress pr", () => {
    const r = parseReviewCycleEvidence("in_progress:abc#parent-retained");
    expect(r.ok).toBe(false);
  });
});

describe("parseInProgressEvidence", () => {
  it("parses pr and ref", () => {
    expect(parseInProgressEvidence("in_progress:12#parent-retained")).toEqual({
      pr: 12,
      ref: "parent-retained",
    });
  });
});

describe("evaluateL4OwnerGate (#3090)", () => {
  it("FAIL: silent hold — PR open claim path with no lease and no done", () => {
    const root = mkdtempSync(join(tmpdir(), "l4-silent-"));
    const result = evaluateL4OwnerGate({
      pr: 99,
      projectRoot: root,
      repo: "deftai/directive",
      now: NOW,
      seams: { fetchComments: () => [] },
    });
    expect(result.exitCode).toBe(1);
    expect(result.path).toBe("none");
    expect(result.message).toContain("silent hold");
    expect(result.message).toContain("Owner Continuity Gate");
  });

  it("PASS: fresh sticky lease", () => {
    const root = mkdtempSync(join(tmpdir(), "l4-lease-"));
    const result = evaluateL4OwnerGate({
      pr: 12,
      projectRoot: root,
      repo: "deftai/directive",
      headSha: "abc123",
      now: NOW,
      seams: {
        fetchComments: () => [
          {
            id: 1,
            body: activeLeaseComment("alice", "monitor-pr-12"),
            htmlUrl: "",
            updatedAt: NOW.toISOString(),
            authorLogin: "alice",
            authorAssociation: "MEMBER",
          },
        ],
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.path).toBe("lease");
    expect(result.monitorRecord?.monitor_agent_id).toBe("monitor-pr-12");
  });

  it("PASS: review_cycle done asserted", () => {
    const root = mkdtempSync(join(tmpdir(), "l4-done-"));
    const result = evaluateL4OwnerGate({
      pr: 12,
      projectRoot: root,
      repo: "deftai/directive",
      reviewCycle: "done",
      seams: { fetchComments: () => [] },
    });
    expect(result.exitCode).toBe(0);
    expect(result.path).toBe("done");
  });

  it("FAIL: parent-retained is process-only (not machine READY)", () => {
    const root = mkdtempSync(join(tmpdir(), "l4-parent-"));
    const result = evaluateL4OwnerGate({
      pr: 12,
      projectRoot: root,
      repo: "deftai/directive",
      reviewCycle: "in_progress:12#parent-retained",
      seams: { fetchComments: () => [] },
    });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("parent-retained");
    expect(result.message).toContain("process path B");
  });

  it("FAIL: parent-retained bound to wrong PR", () => {
    const root = mkdtempSync(join(tmpdir(), "l4-wrong-pr-"));
    const result = evaluateL4OwnerGate({
      pr: 12,
      projectRoot: root,
      repo: "deftai/directive",
      reviewCycle: "in_progress:99#parent-retained",
      seams: { fetchComments: () => [] },
    });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("does not match --pr 12");
  });

  it("FAIL: skipped/n/a do not bypass lease-or-done machine gate", () => {
    const root = mkdtempSync(join(tmpdir(), "l4-skip-"));
    for (const evidence of ["n/a", "skipped:operator-cancel"] as const) {
      const result = evaluateL4OwnerGate({
        pr: 12,
        projectRoot: root,
        repo: "deftai/directive",
        reviewCycle: evidence,
        seams: { fetchComments: () => [] },
      });
      expect(result.exitCode, evidence).toBe(1);
      expect(result.message, evidence).toContain("does not satisfy the machine");
    }
  });

  it("FAIL: in_progress with monitor ref but no lease (regression #2797 class)", () => {
    const root = mkdtempSync(join(tmpdir(), "l4-fake-monitor-"));
    const result = evaluateL4OwnerGate({
      pr: 12,
      projectRoot: root,
      repo: "deftai/directive",
      reviewCycle: "in_progress:12#ghost-monitor",
      seams: { fetchComments: () => [] },
    });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("no sticky");
  });

  it("FAIL: freeform started", () => {
    const root = mkdtempSync(join(tmpdir(), "l4-started-"));
    const result = evaluateL4OwnerGate({
      pr: 12,
      projectRoot: root,
      reviewCycle: "started",
    });
    expect(result.exitCode).toBe(1);
    expect(result.path).toBe("illegal");
  });

  it("json shape includes path and review_cycle", () => {
    const root = mkdtempSync(join(tmpdir(), "l4-json-"));
    const result = evaluateL4OwnerGate({
      pr: 1,
      projectRoot: root,
      repo: "a/b",
      seams: { fetchComments: () => [] },
    });
    const json = l4OwnerResultToJson(result);
    expect(json.path).toBe("none");
    expect(json.ready).toBe(false);
    expect(json.exit_code).toBe(1);
  });
});
