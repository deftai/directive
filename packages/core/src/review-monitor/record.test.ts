import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeExpiresAt,
  renderReleasedReviewOwnerComment,
  renderReviewOwnerComment,
} from "./lease-comment.js";
import { readReviewMonitorFile, registerReviewMonitor, releaseReviewMonitor } from "./record.js";

const NOW = new Date("2026-07-24T12:00:00.000Z");

function activeLeaseBody(owner: string, monitorAgentId: string): string {
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

describe("review-monitor GitHub lease", () => {
  it("creates a sticky comment and does not write local JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-gh-create-"));
    const comments: Array<{ id: number; body: string }> = [];
    let nextId = 100;
    const result = registerReviewMonitor({
      pr: 3,
      repo: "deftai/directive",
      owner: "alice",
      platformPrimitive: "cursor-task",
      monitorAgentId: "rm-3",
      projectRoot: root,
      startedAt: NOW,
      seams: {
        fetchComments: () =>
          comments.map((comment) => ({
            id: comment.id,
            body: comment.body,
            htmlUrl: "",
            updatedAt: NOW.toISOString(),
            authorLogin: "alice",
            authorAssociation: "MEMBER",
          })),
        createComment: (_repo, _pr, body) => {
          nextId += 1;
          comments.push({ id: nextId, body });
          return { id: nextId };
        },
      },
    });
    expect(result.exitCode).toBe(0);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("<!-- deft:review-owner -->");
  });

  it("conflicts when an unexpired foreign lease exists", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-gh-conflict-"));
    const comments = [{ id: 50, body: activeLeaseBody("bob", "rm-bob") }];
    const result = registerReviewMonitor({
      pr: 5,
      repo: "deftai/directive",
      owner: "alice",
      platformPrimitive: "cursor-task",
      monitorAgentId: "rm-alice",
      projectRoot: root,
      startedAt: NOW,
      seams: {
        fetchComments: () =>
          comments.map((comment) => ({
            id: comment.id,
            body: comment.body,
            htmlUrl: "",
            updatedAt: NOW.toISOString(),
            authorLogin: "bob",
            authorAssociation: "MEMBER",
          })),
        updateComment: () => ({ ok: true as const }),
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("held by bob");
  });

  it("resolves create-race to oldest comment and deletes duplicate", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-gh-race-"));
    const comments: Array<{ id: number; body: string }> = [];
    const deleted: number[] = [];
    const result = registerReviewMonitor({
      pr: 7,
      repo: "deftai/directive",
      owner: "alice",
      platformPrimitive: "cursor-task",
      monitorAgentId: "rm-alice",
      projectRoot: root,
      startedAt: NOW,
      seams: {
        fetchComments: () =>
          comments.map((comment) => ({
            id: comment.id,
            body: comment.body,
            htmlUrl: "",
            updatedAt: NOW.toISOString(),
            authorLogin: comment.id === 10 ? "bob" : "alice",
            authorAssociation: "MEMBER",
          })),
        createComment: (_repo, _pr, body) => {
          comments.push({ id: 10, body: activeLeaseBody("bob", "rm-bob") });
          comments.push({ id: 20, body });
          return { id: 20 };
        },
        deleteComment: (_repo, id) => {
          deleted.push(id);
          comments.splice(
            comments.findIndex((comment) => comment.id === id),
            1,
          );
          return { ok: true as const };
        },
      },
    });
    expect(result.exitCode).toBe(1);
    expect(deleted).toEqual([20]);
  });

  it("surfaces create-race delete failures and create errors", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-gh-race-del-"));
    const comments: Array<{ id: number; body: string }> = [];
    let fetchCount = 0;
    const deleteFail = registerReviewMonitor({
      pr: 12,
      repo: "deftai/directive",
      owner: "alice",
      platformPrimitive: "cursor-task",
      monitorAgentId: "rm-alice",
      projectRoot: root,
      startedAt: NOW,
      seams: {
        fetchComments: () => {
          fetchCount += 1;
          if (fetchCount === 1) {
            return [];
          }
          return comments.map((comment) => ({
            id: comment.id,
            body: comment.body,
            htmlUrl: "",
            updatedAt: NOW.toISOString(),
            authorLogin: "alice",
            authorAssociation: "MEMBER",
          }));
        },
        createComment: () => {
          comments.push({ id: 10, body: activeLeaseBody("bob", "rm-bob") });
          comments.push({ id: 20, body: activeLeaseBody("alice", "rm-alice") });
          return { id: 20 };
        },
        deleteComment: () => ({ error: "delete denied" }),
      },
    });
    expect(deleteFail.exitCode).toBe(2);
    expect(deleteFail.message).toContain("delete denied");

    expect(
      registerReviewMonitor({
        pr: 13,
        repo: "deftai/directive",
        owner: "alice",
        platformPrimitive: "cursor-task",
        monitorAgentId: "rm-alice",
        projectRoot: root,
        startedAt: NOW,
        seams: {
          fetchComments: () => [],
          createComment: () => ({ error: "create denied" }),
        },
      }).exitCode,
    ).toBe(2);
  });

  it("allows expired lease takeover without --force", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-gh-expired-"));
    let body = activeLeaseBody("bob", "rm-bob")
      .replace(/expires_at: .+/, "expires_at: 2026-07-24T10:30:00.000Z")
      .replace(/started_at: .+/, "started_at: 2026-07-24T10:00:00.000Z");
    const result = registerReviewMonitor({
      pr: 8,
      repo: "deftai/directive",
      owner: "alice",
      platformPrimitive: "cursor-task",
      monitorAgentId: "rm-alice",
      projectRoot: root,
      startedAt: NOW,
      seams: {
        fetchComments: () => [
          {
            id: 88,
            body,
            htmlUrl: "",
            updatedAt: "2026-07-24T10:00:00.000Z",
            authorLogin: "bob",
            authorAssociation: "MEMBER",
          },
        ],
        updateComment: (_repo, _id, nextBody) => {
          body = nextBody;
          return { ok: true as const };
        },
      },
    });
    expect(result.exitCode).toBe(0);
    expect(body).toContain("owner: alice");
  });

  it("surfaces update failures during expired takeover", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-gh-exp-update-"));
    const body = activeLeaseBody("bob", "rm-bob")
      .replace(/expires_at: .+/, "expires_at: 2026-07-24T10:30:00.000Z")
      .replace(/started_at: .+/, "started_at: 2026-07-24T10:00:00.000Z");
    const result = registerReviewMonitor({
      pr: 14,
      repo: "deftai/directive",
      owner: "alice",
      platformPrimitive: "cursor-task",
      monitorAgentId: "rm-alice",
      projectRoot: root,
      startedAt: NOW,
      seams: {
        fetchComments: () => [
          {
            id: 14,
            body,
            htmlUrl: "",
            updatedAt: "2026-07-24T10:00:00.000Z",
            authorLogin: "bob",
            authorAssociation: "MEMBER",
          },
        ],
        updateComment: () => ({ error: "patch denied" }),
      },
    });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("patch denied");
  });

  it("requires --force for non-expired foreign takeover", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-gh-force-"));
    const withoutForce = registerReviewMonitor({
      pr: 9,
      repo: "deftai/directive",
      owner: "alice",
      platformPrimitive: "cursor-task",
      monitorAgentId: "rm-alice",
      projectRoot: root,
      startedAt: NOW,
      seams: {
        fetchComments: () => [
          {
            id: 90,
            body: activeLeaseBody("bob", "rm-bob"),
            htmlUrl: "",
            updatedAt: NOW.toISOString(),
            authorLogin: "bob",
            authorAssociation: "MEMBER",
          },
        ],
      },
    });
    expect(withoutForce.exitCode).toBe(1);

    const result = registerReviewMonitor({
      pr: 9,
      repo: "deftai/directive",
      owner: "alice",
      platformPrimitive: "cursor-task",
      monitorAgentId: "rm-alice",
      projectRoot: root,
      startedAt: NOW,
      force: true,
      seams: {
        fetchComments: () => [
          {
            id: 90,
            body: activeLeaseBody("bob", "rm-bob"),
            htmlUrl: "",
            updatedAt: NOW.toISOString(),
            authorLogin: "bob",
            authorAssociation: "MEMBER",
          },
        ],
        updateComment: () => ({ ok: true as const }),
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("forced takeover from bob");
    expect(result.priorOwner).toBe("bob");
  });

  it("release ends lease so another owner can claim", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-gh-release-"));
    let body = activeLeaseBody("alice", "rm-alice");
    const seams = {
      fetchComments: () => [
        {
          id: 99,
          body,
          htmlUrl: "",
          updatedAt: NOW.toISOString(),
          authorLogin: "alice",
          authorAssociation: "MEMBER",
        },
      ],
      updateComment: (_repo: string, _id: number, nextBody: string) => {
        body = nextBody;
        return { ok: true as const };
      },
      createComment: (_repo: string, _pr: number, nextBody: string) => {
        body = nextBody;
        return { id: 100 };
      },
    };

    const released = releaseReviewMonitor({
      pr: 10,
      repo: "deftai/directive",
      owner: "alice",
      monitorAgentId: "rm-alice",
      projectRoot: root,
      endedAt: NOW,
      seams,
    });
    expect(released.exitCode).toBe(0);
    expect(body).toContain("ended_at:");

    const claimed = registerReviewMonitor({
      pr: 10,
      repo: "deftai/directive",
      owner: "bob",
      platformPrimitive: "cursor-task",
      monitorAgentId: "rm-bob",
      projectRoot: root,
      startedAt: NOW,
      seams,
    });
    expect(claimed.exitCode).toBe(0);
    expect(claimed.record?.owner).toBe("bob");
  });

  it("release patches the active lease comment, not the oldest anchor", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-gh-release-target-"));
    const staleAnchor = renderReleasedReviewOwnerComment(
      new Date(NOW.getTime() - 60_000).toISOString(),
    );
    let activeBody = activeLeaseBody("alice", "rm-alice");
    const updatedIds: number[] = [];
    const released = releaseReviewMonitor({
      pr: 10,
      repo: "deftai/directive",
      owner: "alice",
      monitorAgentId: "rm-alice",
      projectRoot: root,
      endedAt: NOW,
      seams: {
        fetchComments: () => [
          {
            id: 50,
            body: staleAnchor,
            htmlUrl: "",
            updatedAt: NOW.toISOString(),
            authorLogin: "alice",
            authorAssociation: "MEMBER",
          },
          {
            id: 99,
            body: activeBody,
            htmlUrl: "",
            updatedAt: NOW.toISOString(),
            authorLogin: "alice",
            authorAssociation: "MEMBER",
          },
        ],
        updateComment: (_repo, id, nextBody) => {
          updatedIds.push(id);
          if (id === 99) {
            activeBody = nextBody;
          }
          return { ok: true as const };
        },
      },
    });
    expect(released.exitCode).toBe(0);
    expect(updatedIds).toEqual([99]);
    expect(activeBody).toContain("ended_at:");
  });

  it("renews idempotently for the same monitor_agent_id", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-gh-renew-"));
    let body = activeLeaseBody("alice", "rm-alice");
    const result = registerReviewMonitor({
      pr: 11,
      repo: "deftai/directive",
      owner: "alice",
      platformPrimitive: "cursor-task",
      monitorAgentId: "rm-alice",
      projectRoot: root,
      headSha: "newsha",
      startedAt: NOW,
      seams: {
        fetchComments: () => [
          {
            id: 101,
            body,
            htmlUrl: "",
            updatedAt: NOW.toISOString(),
            authorLogin: "alice",
            authorAssociation: "MEMBER",
          },
        ],
        updateComment: (_repo, _id, nextBody) => {
          body = nextBody;
          return { ok: true as const };
        },
      },
    });
    expect(result.exitCode).toBe(0);
    expect(body).toContain("head_sha: newsha");
  });
});

describe("legacy local JSON helpers", () => {
  it("readReviewMonitorFile always returns empty records (#2814)", () => {
    const { data } = readReviewMonitorFile("/tmp/ignored.json");
    expect(data?.records).toEqual([]);
  });
});
