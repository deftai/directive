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
});
