import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeExpiresAt, renderReviewOwnerComment } from "./lease-comment.js";
import {
  fetchActiveMonitorFromGithub,
  findActiveMonitorForPr,
  findActiveMonitorForPrFromComments,
  isRecordActive,
  readReviewMonitorFile,
  registerReviewMonitor,
  releaseReviewMonitor,
} from "./record.js";

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

describe("review-monitor record branch coverage (#2666)", () => {
  it("readReviewMonitorFile returns empty legacy ledger (#2814)", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-rec-parse-"));
    const { data, error } = readReviewMonitorFile(join(root, ".deft", "review-monitor.json"));
    expect(error).toBeNull();
    expect(data?.records).toEqual([]);
    expect(findActiveMonitorForPr(data as NonNullable<typeof data>, 5, {})).toBeNull();
  });

  it("register surfaces config errors and renew/update failures", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-rec-cfg-"));
    expect(
      registerReviewMonitor({
        pr: 1,
        repo: "deftai/directive",
        owner: null,
        platformPrimitive: "cursor-task",
        monitorAgentId: "rm-1",
        projectRoot: root,
        seams: { getGitHubLogin: () => null },
      }).exitCode,
    ).toBe(2);

    expect(
      registerReviewMonitor({
        pr: 2,
        repo: "deftai/directive",
        owner: "alice",
        platformPrimitive: "cursor-task",
        monitorAgentId: "rm-2",
        projectRoot: root,
        seams: { fetchComments: () => ({ error: "offline" }) },
      }).message,
    ).toContain("offline");

    const body = activeLeaseBody("alice", "rm-3");
    expect(
      registerReviewMonitor({
        pr: 3,
        repo: "deftai/directive",
        owner: "alice",
        platformPrimitive: "cursor-task",
        monitorAgentId: "rm-3",
        projectRoot: root,
        startedAt: NOW,
        seams: {
          fetchComments: () => [
            {
              id: 3,
              body,
              htmlUrl: "",
              updatedAt: NOW.toISOString(),
              authorLogin: "alice",
              authorAssociation: "MEMBER",
            },
          ],
          updateComment: () => ({ error: "denied" }),
        },
      }).exitCode,
    ).toBe(2);
  });

  it("release handles missing lease, conflicts, and update failures", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-rec-rel-"));
    expect(
      releaseReviewMonitor({
        pr: 4,
        repo: "deftai/directive",
        projectRoot: root,
        seams: { fetchComments: () => [] },
      }).message,
    ).toContain("nothing to release");

    const body = activeLeaseBody("bob", "rm-bob");
    expect(
      releaseReviewMonitor({
        pr: 5,
        repo: "deftai/directive",
        owner: "alice",
        monitorAgentId: "rm-alice",
        projectRoot: root,
        endedAt: NOW,
        seams: {
          fetchComments: () => [
            {
              id: 5,
              body,
              htmlUrl: "",
              updatedAt: NOW.toISOString(),
              authorLogin: "bob",
              authorAssociation: "MEMBER",
            },
          ],
        },
      }).exitCode,
    ).toBe(1);

    expect(
      releaseReviewMonitor({
        pr: 6,
        repo: "deftai/directive",
        owner: "bob",
        projectRoot: root,
        endedAt: NOW,
        seams: {
          fetchComments: () => [
            {
              id: 6,
              body,
              htmlUrl: "",
              updatedAt: NOW.toISOString(),
              authorLogin: "bob",
              authorAssociation: "MEMBER",
            },
          ],
          updateComment: () => ({ error: "patch failed" }),
        },
      }).exitCode,
    ).toBe(2);
  });

  it("findActiveMonitor helpers honor ended, expired, and head_sha gates", () => {
    const record = findActiveMonitorForPrFromComments(
      [{ id: 7, body: activeLeaseBody("alice", "rm-7") }],
      7,
      { now: NOW, repo: "deftai/directive" },
    );
    expect(record?.owner).toBe("alice");
    expect(
      fetchActiveMonitorFromGithub("deftai/directive", 8, {
        seams: { fetchComments: () => ({ error: "nope" }) },
      }),
    ).toEqual({ error: "nope" });

    const expired = {
      pr: 9,
      repo: "deftai/directive",
      head_sha: "abc123",
      platform_primitive: "cursor-task" as const,
      monitor_agent_id: "rm-9",
      owner: "alice",
      started_at: "2026-07-24T10:00:00.000Z",
      expires_at: "2026-07-24T10:05:00.000Z",
      worktree_path: null,
      parent_session_id: null,
      ended_at: null,
      comment_id: 9,
    };
    expect(isRecordActive(expired, { now: NOW })).toBe(false);
    expect(isRecordActive({ ...expired, ended_at: NOW.toISOString() }, { now: NOW })).toBe(false);
    expect(
      isRecordActive(expired, { now: new Date("2026-07-24T10:01:00.000Z"), headSha: "zzz" }),
    ).toBe(false);
  });

  it("findActiveMonitorForPr picks newest active legacy record", () => {
    const file = {
      schema_version: 1 as const,
      records: [
        {
          pr: 10,
          repo: "deftai/directive",
          head_sha: null,
          platform_primitive: "cursor-task" as const,
          monitor_agent_id: "rm-old",
          owner: "alice",
          started_at: "2026-07-24T10:00:00.000Z",
          expires_at: computeExpiresAt(new Date("2026-07-24T10:00:00.000Z")),
          worktree_path: null,
          parent_session_id: null,
          ended_at: null,
          comment_id: 1,
        },
        {
          pr: 10,
          repo: "deftai/directive",
          head_sha: null,
          platform_primitive: "cursor-task" as const,
          monitor_agent_id: "rm-new",
          owner: "alice",
          started_at: NOW.toISOString(),
          expires_at: computeExpiresAt(NOW),
          worktree_path: null,
          parent_session_id: null,
          ended_at: null,
          comment_id: 2,
        },
      ],
    };
    const active = findActiveMonitorForPr(file, 10, { now: NOW });
    expect(active?.monitor_agent_id).toBe("rm-new");
  });

  it("release succeeds when owner matches without monitor_agent_id", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-rec-rel-owner-"));
    let body = activeLeaseBody("bob", "rm-bob");
    const result = releaseReviewMonitor({
      pr: 11,
      repo: "deftai/directive",
      owner: "bob",
      projectRoot: root,
      endedAt: NOW,
      seams: {
        fetchComments: () => [
          {
            id: 11,
            body,
            htmlUrl: "",
            updatedAt: NOW.toISOString(),
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
    expect(body).toContain("ended_at:");
  });

  it("create-race reports generic loss when winner lease is unparseable", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-rec-race-null-"));
    const comments: Array<{ id: number; body: string }> = [];
    const result = registerReviewMonitor({
      pr: 12,
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
            authorLogin: "alice",
            authorAssociation: "MEMBER",
          })),
        createComment: (_repo, _pr, body) => {
          comments.push({
            id: 5,
            body: "<!-- deft:review-owner -->\n<!-- /deft:review-owner -->",
          });
          comments.push({ id: 25, body });
          return { id: 25 };
        },
        deleteComment: () => ({ ok: true as const }),
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("create-race lost");
  });

  it("create-race refetch errors surface as config failures", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-rec-race-fetch-"));
    let fetchCalls = 0;
    const result = registerReviewMonitor({
      pr: 13,
      repo: "deftai/directive",
      owner: "alice",
      platformPrimitive: "cursor-task",
      monitorAgentId: "rm-alice",
      projectRoot: root,
      startedAt: NOW,
      seams: {
        fetchComments: () => {
          fetchCalls += 1;
          if (fetchCalls === 1) {
            return [];
          }
          return { error: "race refetch failed" };
        },
        createComment: () => ({ id: 30 }),
      },
    });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("race refetch failed");
  });

  it("isRecordActive rejects invalid lease timestamps", () => {
    expect(
      isRecordActive(
        {
          pr: 14,
          repo: "deftai/directive",
          head_sha: null,
          platform_primitive: "cursor-task",
          monitor_agent_id: "rm-14",
          owner: "alice",
          started_at: "bad",
          expires_at: "also-bad",
          worktree_path: null,
          parent_session_id: null,
          ended_at: null,
          comment_id: 14,
        },
        { now: NOW },
      ),
    ).toBe(false);
  });

  it("release surfaces repo resolution and fetch failures", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-rec-rel-repo-"));
    expect(
      releaseReviewMonitor({
        pr: 15,
        repo: "",
        projectRoot: root,
      }).message,
    ).toContain("could not resolve owner/repo");

    expect(
      releaseReviewMonitor({
        pr: 16,
        repo: "deftai/directive",
        projectRoot: root,
        seams: { fetchComments: () => ({ error: "offline" }) },
      }).exitCode,
    ).toBe(2);
  });

  it("release rejects monitor_agent_id without matching owner (#2814 auth)", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-rec-rel-auth-"));
    const body = activeLeaseBody("bob", "rm-bob");
    expect(
      releaseReviewMonitor({
        pr: 18,
        repo: "deftai/directive",
        owner: "alice",
        monitorAgentId: "rm-bob",
        projectRoot: root,
        endedAt: NOW,
        seams: {
          fetchComments: () => [
            {
              id: 18,
              body,
              htmlUrl: "",
              updatedAt: NOW.toISOString(),
              authorLogin: "bob",
              authorAssociation: "MEMBER",
            },
          ],
        },
      }).exitCode,
    ).toBe(1);
  });

  it("create-race delete failure surfaces config error", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-rec-race-del-"));
    const winnerBody = activeLeaseBody("alice", "rm-winner");
    let fetchCalls = 0;
    const result = registerReviewMonitor({
      pr: 19,
      repo: "deftai/directive",
      owner: "bob",
      platformPrimitive: "cursor-task",
      monitorAgentId: "rm-bob",
      projectRoot: root,
      startedAt: NOW,
      seams: {
        fetchComments: () => {
          fetchCalls += 1;
          if (fetchCalls === 1) {
            return [];
          }
          return [
            {
              id: 20,
              body: winnerBody,
              htmlUrl: "",
              updatedAt: NOW.toISOString(),
              authorLogin: "alice",
              authorAssociation: "MEMBER",
            },
          ];
        },
        createComment: () => ({ id: 21 }),
        deleteComment: () => ({ error: "forbidden delete" }),
      },
    });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("create-race loser could not delete duplicate");
    expect(result.message).toContain("forbidden delete");
  });

  it("create-race refetch listed.error surfaces register config failure", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-rec-race-list-"));
    let fetchCalls = 0;
    const result = registerReviewMonitor({
      pr: 20,
      repo: "deftai/directive",
      owner: "alice",
      platformPrimitive: "cursor-task",
      monitorAgentId: "rm-alice",
      projectRoot: root,
      startedAt: NOW,
      seams: {
        fetchComments: () => {
          fetchCalls += 1;
          if (fetchCalls === 1) {
            return [];
          }
          return { error: "listed offline" };
        },
        createComment: () => ({ id: 22 }),
      },
    });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("review_monitor_register: listed offline");
  });

  it("register createComment error surfaces config failure", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-rec-create-err-"));
    const result = registerReviewMonitor({
      pr: 21,
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
    });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("review_monitor_register: create denied");
  });

  it("register anchor update error surfaces config failure", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-rec-anchor-err-"));
    const result = registerReviewMonitor({
      pr: 22,
      repo: "deftai/directive",
      owner: "alice",
      platformPrimitive: "cursor-task",
      monitorAgentId: "rm-alice",
      projectRoot: root,
      startedAt: NOW,
      seams: {
        fetchComments: () => [
          {
            id: 23,
            body: "<!-- deft:review-owner -->\n<!-- /deft:review-owner -->",
            htmlUrl: "",
            updatedAt: NOW.toISOString(),
            authorLogin: "alice",
            authorAssociation: "MEMBER",
          },
        ],
        updateComment: () => ({ error: "patch denied" }),
      },
    });
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("review_monitor_register: patch denied");
  });
});
