import { describe, expect, it, vi } from "vitest";
import * as ghRest from "../scm/gh-rest.js";
import {
  closePassMarker,
  createReviewOwnerComment,
  deleteReviewOwnerComment,
  fetchActivePassMarker,
  listPassMarkerComments,
  listReviewOwnerComments,
  openPassMarker,
  resolveGitHubLogin,
  updateReviewOwnerComment,
} from "./github-lease.js";
import {
  computeExpiresAt,
  renderPassOpenComment,
  renderReviewOwnerComment,
} from "./lease-comment.js";

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

describe("pass marker GitHub surface (#3607)", () => {
  const PASS_START = new Date("2026-08-28T12:00:00.000Z");
  const PASS_BODY = renderPassOpenComment({
    kind: "pass",
    pass_kind: "design-critique",
    owner: "dbcall2",
    agent_id: "critic-parent-1",
    ceiling: "5430302222",
    started_at: PASS_START.toISOString(),
    expires_at: computeExpiresAt(PASS_START, 60),
    ended_at: null,
  });

  interface ThreadComment {
    id: number;
    body: string;
    htmlUrl: string;
    updatedAt: string;
    authorLogin: string;
    authorAssociation: string;
  }

  function threadComment(
    id: number,
    body: string,
    association = "CONTRIBUTOR",
    authorLogin = "dbcall2",
  ): ThreadComment {
    return {
      id,
      body,
      htmlUrl: "",
      updatedAt: PASS_START.toISOString(),
      authorLogin,
      authorAssociation: association,
    };
  }

  function fakeThread(
    initial: ThreadComment[] = [],
    onCreate?: (comments: ThreadComment[]) => void,
  ) {
    const comments = [...initial];
    let nextId = 1000;
    const seams = {
      fetchComments: () => comments.map((c) => ({ ...c })),
      createComment: (_repo: string, _issue: number, body: string) => {
        const id = nextId;
        nextId += 1;
        comments.push(threadComment(id, body));
        onCreate?.(comments);
        return { id };
      },
      updateComment: (_repo: string, commentId: number, body: string) => {
        const target = comments.find((c) => c.id === commentId);
        if (target === undefined) {
          return { error: `no comment ${commentId}` };
        }
        target.body = body;
        return { ok: true as const };
      },
      deleteComment: (_repo: string, commentId: number) => {
        const index = comments.findIndex((c) => c.id === commentId);
        if (index >= 0) {
          comments.splice(index, 1);
        }
        return { ok: true as const };
      },
    };
    return { comments, seams };
  }

  it("reads a CONTRIBUTOR-authored mark that the ownership lease reader drops", () => {
    // Field instance: comment 5429316778 on PR #3775, authored by dbcall2 with
    // author_association CONTRIBUTOR (#3607 verified-claims table 5455218052).
    const marks = listPassMarkerComments("deftai/directive", 3607, {
      fetchComments: () => [threadComment(5429316778, PASS_BODY)],
    });
    expect(Array.isArray(marks)).toBe(true);
    if (Array.isArray(marks)) {
      expect(marks).toHaveLength(1);
      expect(marks[0]?.id).toBe(5429316778);
      expect(marks[0]?.marker?.owner).toBe("dbcall2");
      expect(marks[0]?.authorLogin).toBe("dbcall2");
    }

    // The same association on the gating lease path stays excluded by #2307.
    expect(
      listReviewOwnerComments("deftai/directive", 3775, {
        fetchComments: () => [threadComment(5429316778, LEASE_BODY)],
      }),
    ).toEqual([]);
  });

  it("opens once, renews only by comment id, and reports an open mark without blocking", () => {
    const thread = fakeThread();
    const opened = openPassMarker({
      repo: "deftai/directive",
      issue: 3607,
      owner: "dbcall2",
      passKind: "design-critique",
      ceiling: "5430302222",
      startedAt: PASS_START,
      seams: thread.seams,
    });
    expect(opened).toMatchObject({ status: "opened", commentId: 1000 });
    expect(thread.comments).toHaveLength(1);

    const renewed = openPassMarker({
      repo: "deftai/directive",
      issue: 3607,
      owner: "dbcall2",
      passKind: "design-critique",
      commentId: 1000,
      startedAt: new Date("2026-08-28T12:30:00.000Z"),
      seams: thread.seams,
    });
    expect(renewed).toMatchObject({ status: "renewed", commentId: 1000 });
    expect(thread.comments).toHaveLength(1);
    expect(thread.comments[0]?.body).toContain("expires_at: 2026-08-28T13:30:00.000Z");

    const observed = openPassMarker({
      repo: "deftai/directive",
      issue: 3607,
      owner: "someone-else",
      passKind: "triage",
      startedAt: new Date("2026-08-28T12:30:00.000Z"),
      seams: thread.seams,
    });
    expect(observed).toMatchObject({ status: "observed", commentId: 1000 });
    if ("marker" in observed) {
      expect(observed.marker.owner).toBe("dbcall2");
    }
    expect(thread.comments).toHaveLength(1);
  });

  it("reports the open mark to a second pass sharing one GitHub login", () => {
    // Every agent on this repo runs under one login, so a same-login second pass is the
    // common case, not an edge case. It is informed rather than allowed to overwrite.
    const thread = fakeThread();
    expect(
      openPassMarker({
        repo: "deftai/directive",
        issue: 3607,
        owner: "dbcall2",
        passKind: "design-critique",
        ceiling: "5430302222",
        startedAt: PASS_START,
        seams: thread.seams,
      }),
    ).toMatchObject({ status: "opened", commentId: 1000 });

    const second = openPassMarker({
      repo: "deftai/directive",
      issue: 3607,
      owner: "dbcall2",
      passKind: "triage",
      ceiling: "9999999999",
      startedAt: new Date("2026-08-28T12:10:00.000Z"),
      seams: thread.seams,
    });
    expect(second).toMatchObject({ status: "observed", commentId: 1000 });
    if ("marker" in second) {
      expect(second.marker.pass_kind).toBe("design-critique");
      expect(second.marker.ceiling).toBe("5430302222");
    }
    expect(thread.comments).toHaveLength(1);
    expect(thread.comments[0]?.body).toContain("pass_kind: design-critique");
  });

  it("creates a fresh comment rather than recycling an expired mark", () => {
    // Recycling is what let two writers share one comment; an open only ever creates.
    for (const author of ["dbcall2", "other-login"]) {
      const thread = fakeThread([threadComment(500, PASS_BODY, "MEMBER", author)]);
      let updates = 0;
      const seams = {
        ...thread.seams,
        updateComment: (repo: string, commentId: number, body: string) => {
          updates += 1;
          return thread.seams.updateComment(repo, commentId, body);
        },
      };
      const opened = openPassMarker({
        repo: "deftai/directive",
        issue: 3607,
        owner: "dbcall2",
        passKind: "triage",
        startedAt: new Date("2026-08-28T14:00:00.000Z"),
        seams,
      });
      expect(opened).toMatchObject({ status: "opened", commentId: 1000 });
      expect(updates).toBe(0);
      expect(thread.comments.map((c) => c.id)).toEqual([500, 1000]);
    }
  });

  it("loses a create race to the older comment id and removes its duplicate", () => {
    const thread = fakeThread([], (comments) => {
      comments.unshift(threadComment(900, PASS_BODY));
    });
    const result = openPassMarker({
      repo: "deftai/directive",
      issue: 3607,
      owner: "late-arriver",
      passKind: "design-critique",
      startedAt: PASS_START,
      seams: thread.seams,
    });
    expect(result).toMatchObject({ status: "observed", commentId: 900 });
    expect(thread.comments.map((c) => c.id)).toEqual([900]);
  });

  it("closes by comment id over the marker as currently read", () => {
    // ended_at is rendered over the freshly read marker, so a close cannot resurrect the
    // metadata its caller opened with after a renewal changed it.
    const thread = fakeThread();
    expect(
      openPassMarker({
        repo: "deftai/directive",
        issue: 3607,
        owner: "dbcall2",
        passKind: "design-critique",
        startedAt: PASS_START,
        seams: thread.seams,
      }),
    ).toMatchObject({ status: "opened", commentId: 1000 });

    openPassMarker({
      repo: "deftai/directive",
      issue: 3607,
      owner: "dbcall2",
      passKind: "review-response",
      ceiling: "7777777777",
      commentId: 1000,
      startedAt: new Date("2026-08-28T12:20:00.000Z"),
      seams: thread.seams,
    });

    expect(
      closePassMarker({
        repo: "deftai/directive",
        issue: 3607,
        owner: "dbcall2",
        commentId: 1000,
        endedAt: new Date("2026-08-28T12:40:00.000Z"),
        seams: thread.seams,
      }),
    ).toEqual({ status: "cleared", commentId: 1000 });
    expect(thread.comments[0]?.body).toContain("pass_kind: review-response");
    expect(thread.comments[0]?.body).toContain("ceiling: 7777777777");
    expect(thread.comments[0]?.body).toContain("ended_at: 2026-08-28T12:40:00.000Z");

    expect(
      closePassMarker({
        repo: "deftai/directive",
        issue: 3607,
        owner: "dbcall2",
        commentId: 1000,
        endedAt: new Date("2026-08-28T12:50:00.000Z"),
        seams: thread.seams,
      }),
    ).toEqual({ status: "not-open", commentId: null });
  });

  it("clears its own open mark without an id, and refuses another author's", () => {
    const thread = fakeThread([threadComment(500, PASS_BODY)]);
    const endedAt = new Date("2026-08-28T12:20:00.000Z");

    const foreign = fakeThread([threadComment(500, PASS_BODY, "MEMBER", "other-login")]);
    expect(
      closePassMarker({
        repo: "deftai/directive",
        issue: 3607,
        owner: "dbcall2",
        endedAt,
        seams: foreign.seams,
      }),
    ).toEqual({ status: "held-by-other", commentId: 500 });

    expect(
      closePassMarker({
        repo: "deftai/directive",
        issue: 3607,
        owner: "someone-else",
        endedAt,
        seams: thread.seams,
      }),
    ).toEqual({ status: "held-by-other", commentId: 500 });

    expect(
      closePassMarker({
        repo: "deftai/directive",
        issue: 3607,
        owner: "dbcall2",
        endedAt,
        seams: thread.seams,
      }),
    ).toEqual({ status: "cleared", commentId: 500 });

    expect(
      fetchActivePassMarker("deftai/directive", 3607, { now: endedAt, seams: thread.seams }),
    ).toBeNull();

    expect(
      closePassMarker({
        repo: "deftai/directive",
        issue: 3607,
        owner: "dbcall2",
        endedAt,
        seams: thread.seams,
      }),
    ).toEqual({ status: "not-open", commentId: null });
  });

  it("reads back the active mark for an arriving agent", () => {
    const thread = fakeThread([threadComment(500, PASS_BODY)]);
    const active = fetchActivePassMarker("deftai/directive", 3607, {
      now: new Date("2026-08-28T12:30:00.000Z"),
      seams: thread.seams,
    });
    expect(active).toMatchObject({ commentId: 500 });
    if (active !== null && "marker" in active) {
      expect(active.marker.pass_kind).toBe("design-critique");
      expect(active.marker.ceiling).toBe("5430302222");
    }
  });

  it("surfaces errors from list, create, renew, re-list and close", () => {
    const failing = { fetchComments: () => ({ error: "boom" }) };
    expect(listPassMarkerComments("deftai/directive", 3607, failing)).toEqual({ error: "boom" });
    expect(fetchActivePassMarker("deftai/directive", 3607, { seams: failing })).toEqual({
      error: "boom",
    });
    expect(
      openPassMarker({
        repo: "deftai/directive",
        issue: 3607,
        owner: "dbcall2",
        passKind: "design-critique",
        seams: failing,
      }),
    ).toEqual({ error: "boom" });
    expect(
      closePassMarker({ repo: "deftai/directive", issue: 3607, owner: "dbcall2", seams: failing }),
    ).toEqual({ error: "boom" });

    expect(
      openPassMarker({
        repo: "deftai/directive",
        issue: 3607,
        owner: "dbcall2",
        passKind: "design-critique",
        commentId: 1000,
        seams: { updateComment: () => ({ error: "patch denied" }) },
      }),
    ).toEqual({ error: "patch denied" });

    expect(
      openPassMarker({
        repo: "deftai/directive",
        issue: 3607,
        owner: "dbcall2",
        passKind: "design-critique",
        seams: { fetchComments: () => [], createComment: () => ({ error: "post denied" }) },
      }),
    ).toEqual({ error: "post denied" });

    let listCalls = 0;
    expect(
      openPassMarker({
        repo: "deftai/directive",
        issue: 3607,
        owner: "dbcall2",
        passKind: "design-critique",
        seams: {
          fetchComments: () => {
            listCalls += 1;
            return listCalls === 1 ? [] : { error: "relist failed" };
          },
          createComment: () => ({ id: 1000 }),
        },
      }),
    ).toEqual({ error: "relist failed" });

    const raced = fakeThread([], (comments) => {
      comments.unshift(threadComment(900, PASS_BODY));
    });
    expect(
      openPassMarker({
        repo: "deftai/directive",
        issue: 3607,
        owner: "late-arriver",
        passKind: "design-critique",
        startedAt: PASS_START,
        seams: { ...raced.seams, deleteComment: () => ({ error: "delete denied" }) },
      }),
    ).toEqual({ error: "delete denied" });

    expect(
      closePassMarker({
        repo: "deftai/directive",
        issue: 3607,
        owner: "dbcall2",
        endedAt: new Date("2026-08-28T12:20:00.000Z"),
        seams: {
          fetchComments: () => [threadComment(500, PASS_BODY)],
          updateComment: () => ({ error: "patch denied" }),
        },
      }),
    ).toEqual({ error: "patch denied" });
  });
});
