import { describe, expect, it } from "vitest";
import {
  computeExpiresAt,
  findActiveLeaseComment,
  hasReviewOwnerMarker,
  isLeaseActive,
  isLeaseExpired,
  mapCommentEntry,
  parseIso8601Utc,
  parseReviewOwnerLease,
  renderReleasedReviewOwnerComment,
  renderReviewOwnerComment,
  selectWinningReviewOwnerComment,
} from "./lease-comment.js";

const NOW = new Date("2026-07-24T12:00:00.000Z");

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

  it("covers parse helpers and active-lease selection", () => {
    expect(parseIso8601Utc("")).toBeNull();
    expect(parseIso8601Utc("2026-07-24T12:00:00.000Z")?.toISOString()).toBe(
      "2026-07-24T12:00:00.000Z",
    );
    expect(parseIso8601Utc("not-a-date")).toBeNull();
    expect(hasReviewOwnerMarker("<!-- deft:review-owner -->")).toBe(true);
    expect(mapCommentEntry(null)).toBeNull();
    expect(mapCommentEntry({ id: 1, body: "no marker" })).toBeNull();
    expect(findActiveLeaseComment([])).toBeNull();
    expect(renderReleasedReviewOwnerComment("2026-07-24T13:00:00.000Z")).toContain("ended_at:");
    expect(selectWinningReviewOwnerComment([])).toBeNull();
    expect(
      parseReviewOwnerLease("<!-- deft:review-owner --><!-- /deft:review-owner -->"),
    ).toBeNull();
    const endedLease = {
      owner: "alice",
      monitor_agent_id: "rm-1",
      head_sha: null,
      started_at: "2026-07-24T12:00:00.000Z",
      expires_at: "2026-07-24T12:30:00.000Z",
      platform_primitive: "cursor-task" as const,
      ended_at: "2026-07-24T12:20:00.000Z",
    };
    expect(isLeaseActive(endedLease, { now: new Date("2026-07-24T12:10:00.000Z") })).toBe(false);
    expect(isLeaseExpired(endedLease, new Date("2026-07-24T12:10:00.000Z"))).toBe(true);
    expect(parseIso8601Utc("2026-07-24T12:00:00+00:00")?.toISOString()).toBe(
      "2026-07-24T12:00:00.000Z",
    );
    expect(
      renderReviewOwnerComment({
        owner: "bob",
        monitor_agent_id: "rm-2",
        head_sha: null,
        started_at: "2026-07-24T12:00:00.000Z",
        expires_at: "2026-07-24T12:30:00.000Z",
        platform_primitive: "cursor-task",
        ended_at: null,
      }),
    ).toContain("head_sha:");
    const body = renderReviewOwnerComment({
      owner: "alice",
      monitor_agent_id: "rm-8",
      head_sha: "abc",
      started_at: NOW.toISOString(),
      expires_at: computeExpiresAt(NOW),
      platform_primitive: "cursor-task",
      ended_at: null,
    });
    const activeComment = {
      id: 8,
      body,
      createdAt: NOW.toISOString(),
      lease: parseReviewOwnerLease(body),
    };
    expect(findActiveLeaseComment([activeComment], { now: NOW })?.id).toBe(8);
  });
});
