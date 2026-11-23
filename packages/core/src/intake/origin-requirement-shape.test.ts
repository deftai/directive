import { describe, expect, it } from "vitest";
import type { IssueComment } from "./issue-ingest.js";
import {
  classifyOriginRequirementShape,
  commentAuthorLogin,
  hasDesignCritiqueCommentLead,
  selectedCurrentShapeId,
} from "./origin-requirement-shape.js";

const AC_BODY = "Extra.\n\n## Acceptance Criteria\n\n- [ ] the new criterion holds\n";

function comment(id: number, body: string, login: string | null = "alice"): IssueComment {
  return {
    id,
    body,
    ...(login !== null ? { user: { login } } : {}),
    author_association: "OWNER",
    updated_at: "2026-11-01T10:00:00Z",
  };
}

const never = (): boolean | null => {
  throw new Error("permission lookup must not run");
};

describe("hasDesignCritiqueCommentLead (#7138)", () => {
  it("matches a model: line followed by a role: line", () => {
    expect(hasDesignCritiqueCommentLead("model: gpt-6\nrole: critic\n\nbody")).toBe(true);
    expect(hasDesignCritiqueCommentLead("\n  model: claude\n\n role: parent")).toBe(true);
  });

  it("rejects prose, a lone model line and the reverse order", () => {
    expect(hasDesignCritiqueCommentLead("Model: the team decided")).toBe(false);
    expect(hasDesignCritiqueCommentLead("model: gpt-6\nplain text")).toBe(false);
    expect(hasDesignCritiqueCommentLead("role: critic\nmodel: gpt-6")).toBe(false);
    expect(hasDesignCritiqueCommentLead("")).toBe(false);
  });
});

describe("classifyOriginRequirementShape (#7138)", () => {
  it("flags a design-critique record without a permission lookup", () => {
    expect(
      classifyOriginRequirementShape({
        comment: comment(1, "model: gpt-6\nrole: critic\n\nfindings"),
        currentShapeId: null,
        issueAuthor: null,
        mayWrite: never,
      }),
    ).toBe("design-critique");
  });

  it("flags the selected Current shape comment", () => {
    expect(
      classifyOriginRequirementShape({
        comment: comment(2, "plain"),
        currentShapeId: 2,
        issueAuthor: null,
        mayWrite: never,
      }),
    ).toBe("current-shape");
  });

  it("flags an Acceptance Criteria list by the issue author without a lookup", () => {
    expect(
      classifyOriginRequirementShape({
        comment: comment(3, AC_BODY, "Owner"),
        currentShapeId: null,
        issueAuthor: "owner",
        mayWrite: never,
      }),
    ).toBe("acceptance-criteria");
  });

  it("asks the write lookup for another author: writer, non-writer, unknown", () => {
    const base = { comment: comment(4, AC_BODY), currentShapeId: null, issueAuthor: "owner" };
    expect(classifyOriginRequirementShape({ ...base, mayWrite: () => true })).toBe(
      "acceptance-criteria",
    );
    expect(classifyOriginRequirementShape({ ...base, mayWrite: () => false })).toBeNull();
    expect(classifyOriginRequirementShape({ ...base, mayWrite: () => null })).toBe(
      "permission-unknown",
    );
  });

  it("treats an Acceptance Criteria list with no author as permission unknown", () => {
    expect(
      classifyOriginRequirementShape({
        comment: comment(5, AC_BODY, null),
        currentShapeId: null,
        issueAuthor: "owner",
        mayWrite: never,
      }),
    ).toBe("permission-unknown");
  });

  it("returns null for a plain comment", () => {
    expect(
      classifyOriginRequirementShape({
        comment: comment(6, "Thanks, looks good."),
        currentShapeId: 99,
        issueAuthor: "owner",
        mayWrite: never,
      }),
    ).toBeNull();
  });
});

describe("selectedCurrentShapeId / commentAuthorLogin", () => {
  it("returns the id the ingest selector picks, else null", () => {
    const shape = comment(7, "## Current shape (as of pass-2)\n\nOpen children: none.");
    expect(selectedCurrentShapeId([comment(6, "plain"), shape])).toBe(7);
    expect(selectedCurrentShapeId([comment(6, "plain")])).toBeNull();
  });

  it("reads the author login or null", () => {
    expect(commentAuthorLogin(comment(1, "x", "bob"))).toBe("bob");
    expect(commentAuthorLogin(comment(1, "x", null))).toBeNull();
    expect(commentAuthorLogin({ id: 1, body: "x", user: { login: "" } })).toBeNull();
  });
});
