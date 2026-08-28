import { describe, expect, it } from "vitest";
import { DEFAULT_PASS_STALE_MINUTES } from "./constants.js";
import {
  computeExpiresAt,
  findActiveLeaseComment,
  findActivePassComment,
  hasReviewOwnerMarker,
  isLeaseActive,
  isLeaseExpired,
  isPassMarkerActive,
  mapCommentEntry,
  mapPassCommentEntry,
  type PassOpenComment,
  type PassOpenMarker,
  parseIso8601Utc,
  parsePassOpenMarker,
  parseReviewOwnerLease,
  renderPassOpenComment,
  renderReleasedReviewOwnerComment,
  renderReviewOwnerComment,
  selectWinningPassComment,
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

describe("pass-open advisory marker (#3607)", () => {
  const PASS_START = new Date("2026-08-28T12:00:00.000Z");
  const MARKER: PassOpenMarker = {
    kind: "pass",
    pass_kind: "design-critique",
    owner: "alice",
    agent_id: "critic-parent-1",
    ceiling: "5430302222",
    started_at: PASS_START.toISOString(),
    expires_at: computeExpiresAt(PASS_START, DEFAULT_PASS_STALE_MINUTES),
    ended_at: null,
  };

  it("round-trips a mark carrying its own expiry", () => {
    const body = renderPassOpenComment(MARKER);
    expect(body).toContain("kind: pass");
    expect(body).toContain("pass_kind: design-critique");
    expect(body).toContain("ceiling: 5430302222");
    expect(body).toContain("expires_at: 2026-08-28T13:00:00.000Z");
    expect(parsePassOpenMarker(body)).toEqual(MARKER);
  });

  it("ignores an expired or cleared mark on read", () => {
    const comment = mapPassCommentEntry({
      id: 7,
      body: renderPassOpenComment(MARKER),
      created_at: MARKER.started_at,
    }) as PassOpenComment;
    const inside = new Date("2026-08-28T12:30:00.000Z");
    const after = new Date("2026-08-28T13:30:00.000Z");

    expect(isPassMarkerActive(MARKER, inside)).toBe(true);
    expect(isPassMarkerActive(MARKER, after)).toBe(false);
    expect(findActivePassComment([comment], { now: inside })?.id).toBe(7);
    expect(findActivePassComment([comment], { now: after })).toBeNull();

    const cleared = { ...MARKER, ended_at: "2026-08-28T12:10:00.000Z" };
    expect(isPassMarkerActive(cleared, inside)).toBe(false);
    expect(parsePassOpenMarker(renderPassOpenComment(cleared))?.ended_at).toBe(
      "2026-08-28T12:10:00.000Z",
    );
  });

  it("resolves two racing marks to the oldest comment id", () => {
    const older = mapPassCommentEntry({
      id: 100,
      body: renderPassOpenComment(MARKER),
    }) as PassOpenComment;
    const newer = mapPassCommentEntry({
      id: 200,
      body: renderPassOpenComment({ ...MARKER, owner: "bob" }),
    }) as PassOpenComment;
    const winner = findActivePassComment([newer, older], {
      now: new Date("2026-08-28T12:05:00.000Z"),
    });
    expect(winner?.id).toBe(100);
    expect(winner?.marker?.owner).toBe("alice");
    expect(selectWinningPassComment([])).toBeNull();
  });

  it("never satisfies the ownership lease path", () => {
    const body = renderPassOpenComment(MARKER);
    expect(parseReviewOwnerLease(body)).toBeNull();
    expect(mapCommentEntry({ id: 7, body })).toBeNull();
  });

  it("rejects malformed marks", () => {
    expect(parsePassOpenMarker("no marker here")).toBeNull();
    expect(
      parsePassOpenMarker("<!-- deft:review-owner -->\nowner: alice\n<!-- /deft:review-owner -->"),
    ).toBeNull();
    expect(
      parsePassOpenMarker(
        "<!-- deft:review-owner -->\nkind: pass\nowner: alice\n<!-- /deft:review-owner -->",
      ),
    ).toBeNull();
    expect(mapPassCommentEntry(null)).toBeNull();
    expect(mapPassCommentEntry({ id: 7, body: "no marker" })).toBeNull();
    expect(mapPassCommentEntry({ id: "7", body: renderPassOpenComment(MARKER) })).toBeNull();
    expect(mapPassCommentEntry({ id: 7, body: renderPassOpenComment(MARKER) })?.createdAt).toBe("");
  });
});
