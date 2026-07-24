import { describe, expect, it } from "vitest";
import {
  computeExpiresAt,
  isLeaseActive,
  isLeaseExpired,
  parseReviewOwnerLease,
  renderReviewOwnerComment,
  selectWinningReviewOwnerComment,
} from "./lease-comment.js";

describe("review-owner lease comment", () => {
  it("parses and renders a claim block", () => {
    const body =
      "<!-- deft:review-owner -->\n" +
      "owner: alice\n" +
      "monitor_agent_id: rm-1\n" +
      "head_sha: abc\n" +
      "started_at: 2026-07-24T12:00:00.000Z\n" +
      "expires_at: 2026-07-24T12:30:00.000Z\n" +
      "platform_primitive: cursor-task\n" +
      "<!-- /deft:review-owner -->";
    const lease = parseReviewOwnerLease(body);
    expect(lease?.owner).toBe("alice");
    expect(lease?.monitor_agent_id).toBe("rm-1");
    expect(renderReviewOwnerComment(lease as NonNullable<typeof lease>)).toContain("owner: alice");
  });

  it("selects oldest comment id as create-race winner", () => {
    const winner = selectWinningReviewOwnerComment([
      { id: 20, body: "", createdAt: "", lease: null },
      { id: 10, body: "", createdAt: "", lease: null },
    ]);
    expect(winner?.id).toBe(10);
  });

  it("detects active vs expired leases", () => {
    const now = new Date("2026-07-24T12:15:00.000Z");
    const lease = {
      owner: "alice",
      monitor_agent_id: "rm-1",
      head_sha: "abc",
      started_at: "2026-07-24T12:00:00.000Z",
      expires_at: computeExpiresAt(new Date("2026-07-24T12:00:00.000Z")),
      platform_primitive: "cursor-task" as const,
      ended_at: null,
    };
    expect(isLeaseActive(lease, { now })).toBe(true);
    expect(isLeaseExpired(lease, now)).toBe(false);
    expect(isLeaseActive(lease, { now, headSha: "zzz" })).toBe(false);
  });
});
