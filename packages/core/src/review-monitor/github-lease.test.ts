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

  function threadComment(id: number, body: string, association = "CONTRIBUTOR"): ThreadComment {
    return {
      id,
      body,
      htmlUrl: "",
      updatedAt: PASS_START.toISOString(),
      authorLogin: "dbcall2",
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
    const fieldComment = threadComment(5429316778, PASS_BODY);

    const marks = listPassMarkerComments("deftai/directive", 3607, {
      fetchComments: () => [fieldComment],
    });
    expect(Array.isArray(marks)).toBe(true);
    if (Array.isArray(marks)) {
      expect(marks).toHaveLength(1);
      expect(marks[0]?.id).toBe(5429316778);
      expect(marks[0]?.marker?.owner).toBe("dbcall2");
    }

    // The same association on the gating lease path stays excluded by #2307.
    expect(
      listReviewOwnerComments("deftai/directive", 3775, {
        fetchComments: () => [threadComment(5429316778, LEASE_BODY)],
      }),
    ).toEqual([]);
  });

  it("opens, renews, and reports another owner's open mark without blocking", () => {
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

    const renewedAt = new Date("2026-08-28T12:30:00.000Z");
    const renewed = openPassMarker({
      repo: "deftai/directive",
      issue: 3607,
      owner: "dbcall2",
      passKind: "design-critique",
      startedAt: renewedAt,
      seams: thread.seams,
    });
    expect(renewed).toMatchObject({ status: "renewed", commentId: 1000 });
    expect(thread.comments).toHaveLength(1);

    const observed = openPassMarker({
      repo: "deftai/directive",
      issue: 3607,
      owner: "someone-else",
      passKind: "triage",
      startedAt: renewedAt,
      seams: thread.seams,
    });
    expect(observed).toMatchObject({ status: "observed", commentId: 1000 });
    if ("marker" in observed) {
      expect(observed.marker.owner).toBe("dbcall2");
    }
    expect(thread.comments).toHaveLength(1);
  });

  it("reuses an expired mark comment instead of stacking a second one", () => {
    const thread = fakeThread([threadComment(500, PASS_BODY)]);
    const afterExpiry = new Date("2026-08-28T14:00:00.000Z");
    const opened = openPassMarker({
      repo: "deftai/directive",
      issue: 3607,
      owner: "someone-else",
      passKind: "triage",
      startedAt: afterExpiry,
      seams: thread.seams,
    });
    expect(opened).toMatchObject({ status: "opened", commentId: 500 });
    expect(thread.comments).toHaveLength(1);
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

  it("clears its own mark, reports another owner's, and no-ops when none is open", () => {
    const thread = fakeThread([threadComment(500, PASS_BODY)]);
    const endedAt = new Date("2026-08-28T12:20:00.000Z");

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

  it("surfaces fetch errors on every pass-marker entry point", () => {
    const seams = { fetchComments: () => ({ error: "boom" }) };
    expect(listPassMarkerComments("deftai/directive", 3607, seams)).toEqual({ error: "boom" });
    expect(fetchActivePassMarker("deftai/directive", 3607, { seams })).toEqual({ error: "boom" });
    expect(
      openPassMarker({
        repo: "deftai/directive",
        issue: 3607,
        owner: "dbcall2",
        passKind: "design-critique",
        seams,
      }),
    ).toEqual({ error: "boom" });
    expect(
      closePassMarker({ repo: "deftai/directive", issue: 3607, owner: "dbcall2", seams }),
    ).toEqual({ error: "boom" });
  });

  it("reads back the active mark for an arriving agent", () => {
    const thread = fakeThread([threadComment(500, PASS_BODY)]);
    const active = fetchActivePassMarker("deftai/directive", 3607, {
      now: new Date("2026-08-28T12:30:00.000Z"),
      seams: thread.seams,
    });
    expect(active).toMatchObject({ commentId: 500 });
    if (active !== null && active !== undefined && "marker" in active) {
      expect(active.marker.pass_kind).toBe("design-critique");
      expect(active.marker.ceiling).toBe("5430302222");
    }
  });

  it("surfaces write-path errors from create, update, delete and re-list", () => {
    const emptyThread = { fetchComments: () => [] as never[] };

    expect(
      openPassMarker({
        repo: "deftai/directive",
        issue: 3607,
        owner: "dbcall2",
        passKind: "design-critique",
        seams: { ...emptyThread, createComment: () => ({ error: "post denied" }) },
      }),
    ).toEqual({ error: "post denied" });

    expect(
      openPassMarker({
        repo: "deftai/directive",
        issue: 3607,
        owner: "dbcall2",
        passKind: "design-critique",
        startedAt: PASS_START,
        seams: {
          fetchComments: () => [threadComment(500, PASS_BODY)],
          updateComment: () => ({ error: "patch denied" }),
        },
      }),
    ).toEqual({ error: "patch denied" });

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

    expect(
      openPassMarker({
        repo: "deftai/directive",
        issue: 3607,
        owner: "late-arriver",
        passKind: "design-critique",
        startedAt: PASS_START,
        seams: {
          fetchComments: () => (listCalls++ === 2 ? [] : [threadComment(900, PASS_BODY)]),
          createComment: () => ({ id: 1000 }),
          deleteComment: () => ({ error: "delete denied" }),
        },
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

  it("arbitrates a reused marker comment against a concurrent writer", () => {
    const OTHER_BODY = renderPassOpenComment({
      kind: "pass",
      pass_kind: "triage",
      owner: "other-owner",
      agent_id: null,
      ceiling: null,
      started_at: "2026-08-28T13:59:00.000Z",
      expires_at: "2026-08-28T14:59:00.000Z",
      ended_at: null,
    });
    const afterExpiry = new Date("2026-08-28T14:00:00.000Z");

    // Our PATCH lands, but the re-list shows an older comment carrying a live mark:
    // oldest id wins, so we report the winner instead of a false `opened`.
    let calls = 0;
    const contested = openPassMarker({
      repo: "deftai/directive",
      issue: 3607,
      owner: "dbcall2",
      passKind: "design-critique",
      startedAt: afterExpiry,
      seams: {
        fetchComments: () => {
          calls += 1;
          return calls === 1
            ? [threadComment(500, PASS_BODY)]
            : [threadComment(400, OTHER_BODY), threadComment(500, PASS_BODY)];
        },
        updateComment: () => ({ ok: true as const }),
      },
    });
    expect(contested).toMatchObject({ status: "observed", commentId: 400 });
    if ("marker" in contested) {
      expect(contested.marker.owner).toBe("other-owner");
    }

    expect(
      openPassMarker({
        repo: "deftai/directive",
        issue: 3607,
        owner: "dbcall2",
        passKind: "design-critique",
        startedAt: afterExpiry,
        seams: {
          fetchComments: () =>
            calls++ < 3 ? [threadComment(500, PASS_BODY)] : { error: "relist failed" },
          updateComment: () => ({ ok: true as const }),
        },
      }),
    ).toEqual({ error: "relist failed" });
  });
});
