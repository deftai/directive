import { describe, expect, it, vi } from "vitest";
import * as ghRest from "../scm/gh-rest.js";
import {
  createReviewOwnerComment,
  deleteReviewOwnerComment,
  listReviewOwnerComments,
  resolveGitHubLogin,
  updateReviewOwnerComment,
} from "./github-lease.js";
import { renderReviewOwnerComment } from "./lease-comment.js";

const LEASE_BODY = renderReviewOwnerComment({
  owner: "alice",
  monitor_agent_id: "rm-1",
  head_sha: "abc",
  started_at: "2026-07-24T12:00:00.000Z",
  expires_at: "2026-07-24T12:30:00.000Z",
  platform_primitive: "cursor-task",
  ended_at: null,
});

describe("review-owner GitHub lease seams", () => {
  it("lists mapped review-owner comments and surfaces fetch errors", () => {
    const listed = listReviewOwnerComments("deftai/directive", 1, {
      fetchComments: () => [
        {
          id: 1,
          body: LEASE_BODY,
          htmlUrl: "",
          updatedAt: "2026-07-24T12:00:00.000Z",
          authorLogin: "alice",
          authorAssociation: "MEMBER",
        },
        {
          id: 2,
          body: "plain comment",
          htmlUrl: "",
          updatedAt: "",
          authorLogin: "",
          authorAssociation: "",
        },
      ],
    });
    expect(Array.isArray(listed)).toBe(true);
    if (Array.isArray(listed)) {
      expect(listed).toHaveLength(1);
      expect(listed[0]?.lease?.owner).toBe("alice");
    }

    expect(
      listReviewOwnerComments("deftai/directive", 2, {
        fetchComments: () => ({ error: "boom" }),
      }),
    ).toEqual({ error: "boom" });

    expect(listReviewOwnerComments("deftai/directive", 4, { fetchComments: () => [] })).toEqual([]);
  });

  it("ignores non-maintainer-authored marker comments", () => {
    expect(
      listReviewOwnerComments("deftai/directive", 3, {
        fetchComments: () => [
          {
            id: 1,
            body: LEASE_BODY,
            htmlUrl: "",
            updatedAt: "2026-07-24T12:00:00.000Z",
            authorLogin: "attacker",
            authorAssociation: "NONE",
          },
        ],
      }),
    ).toEqual([]);
  });

  it("create/update/delete honor custom seams", () => {
    expect(
      createReviewOwnerComment("deftai/directive", 1, LEASE_BODY, {
        createComment: () => ({ id: 9 }),
      }),
    ).toEqual({ id: 9 });

    expect(
      updateReviewOwnerComment("deftai/directive", 9, LEASE_BODY, {
        updateComment: () => ({ ok: true }),
      }),
    ).toEqual({ ok: true });

    expect(
      updateReviewOwnerComment("deftai/directive", 9, LEASE_BODY, {
        updateComment: () => ({ error: "denied" }),
      }),
    ).toEqual({ error: "denied" });

    expect(
      deleteReviewOwnerComment("deftai/directive", 9, {
        deleteComment: () => ({ ok: true }),
      }),
    ).toEqual({ ok: true });

    expect(
      deleteReviewOwnerComment("deftai/directive", 9, {
        deleteComment: () => ({ error: "gone" }),
      }),
    ).toEqual({ error: "gone" });
  });

  it("REST wrappers surface errors and missing ids", () => {
    const postSpy = vi.spyOn(ghRest, "restPostComment").mockImplementation(() => {
      throw new Error("post failed");
    });
    expect(createReviewOwnerComment("deftai/directive", 1, LEASE_BODY)).toEqual({
      error: "post failed",
    });
    postSpy.mockRestore();

    const postNoId = vi.spyOn(ghRest, "restPostComment").mockReturnValue({});
    expect(createReviewOwnerComment("deftai/directive", 1, LEASE_BODY)).toEqual({
      error: "create comment: response missing id",
    });
    postNoId.mockRestore();

    const updateSpy = vi.spyOn(ghRest, "restUpdateComment").mockImplementation(() => {
      throw new Error("patch failed");
    });
    expect(updateReviewOwnerComment("deftai/directive", 9, LEASE_BODY)).toEqual({
      error: "patch failed",
    });
    updateSpy.mockRestore();

    const deleteSpy = vi.spyOn(ghRest, "restDeleteComment").mockImplementation(() => {
      throw new Error("delete failed");
    });
    expect(deleteReviewOwnerComment("deftai/directive", 9)).toEqual({ error: "delete failed" });
    deleteSpy.mockRestore();
  });

  it("resolveGitHubLogin uses seam or REST login", () => {
    expect(resolveGitHubLogin({ getGitHubLogin: () => "alice" })).toBe("alice");
    expect(resolveGitHubLogin({ getGitHubLogin: () => null })).toBeNull();

    const userSpy = vi.spyOn(ghRest, "restGetUser").mockReturnValue({ login: "ci-bot" });
    expect(resolveGitHubLogin()).toBe("ci-bot");
    userSpy.mockRestore();

    const emptyLogin = vi.spyOn(ghRest, "restGetUser").mockReturnValue({ login: "" });
    expect(resolveGitHubLogin()).toBeNull();
    emptyLogin.mockRestore();

    const failSpy = vi.spyOn(ghRest, "restGetUser").mockImplementation(() => {
      throw new Error("no auth");
    });
    expect(resolveGitHubLogin()).toBeNull();
    failSpy.mockRestore();
  });
});
