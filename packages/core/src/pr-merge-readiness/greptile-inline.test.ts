import { describe, expect, it } from "vitest";
import {
  evaluateInlineReviewThreads,
  fetchGreptilePullCommentsRest,
  fetchUnresolvedGreptileInlineFindings,
  headShaMatches,
  type InlineReviewThread,
  loadThinHtmlInlineFindings,
} from "./greptile-inline.js";
import type { RunGhFn } from "./types.js";

const HEAD = "3a277b7ab847f0baeba85a673dea811027d9634f";
const OLD = "b5f89c30435a428acffe4b989f633854f6261786";

const INLINE_P1_BODY =
  '<img alt="P1" src="https://greptile-static-assets.s3.amazonaws.com/badges/p1.svg?v=9" align="top"> ' +
  "**Path traversal via `..` in owner/repo segments**";

function thread(
  overrides: Partial<InlineReviewThread> & { comments?: InlineReviewThread["comments"] },
): InlineReviewThread {
  return {
    isResolved: false,
    isOutdated: false,
    comments: [],
    ...overrides,
  };
}

describe("headShaMatches", () => {
  it("matches full and short SHAs in either direction", () => {
    expect(headShaMatches(HEAD.slice(0, 7), HEAD)).toBe(true);
    expect(headShaMatches(HEAD, HEAD.slice(0, 7))).toBe(true);
  });

  it("rejects unrelated SHAs", () => {
    expect(headShaMatches(OLD, HEAD)).toBe(false);
  });
});

describe("evaluateInlineReviewThreads", () => {
  it("counts unresolved Greptile inline P1 on current HEAD (#2620)", () => {
    const findings = evaluateInlineReviewThreads(
      [
        thread({
          comments: [
            {
              authorLogin: "greptile-apps[bot]",
              body: INLINE_P1_BODY,
              path: "server/src/register/github.ts",
              commitOid: HEAD,
            },
          ],
        }),
      ],
      HEAD,
    );
    expect(findings).toEqual({
      p0Count: 0,
      p1Count: 1,
      unresolvedThreadCount: 1,
      error: null,
    });
  });

  it("ignores resolved threads even when summary badge counts are zero", () => {
    const findings = evaluateInlineReviewThreads(
      [
        thread({
          isResolved: true,
          comments: [
            {
              authorLogin: "greptile-apps[bot]",
              body: INLINE_P1_BODY,
              path: "server/src/register/github.ts",
              commitOid: HEAD,
            },
          ],
        }),
      ],
      HEAD,
    );
    expect(findings.p0Count).toBe(0);
    expect(findings.p1Count).toBe(0);
  });

  it("ignores outdated threads on prior HEAD SHAs", () => {
    const findings = evaluateInlineReviewThreads(
      [
        thread({
          isOutdated: true,
          comments: [
            {
              authorLogin: "greptile-apps[bot]",
              body: INLINE_P1_BODY,
              path: "server/src/cli/program.ts",
              commitOid: OLD,
            },
          ],
        }),
      ],
      HEAD,
    );
    expect(findings.p1Count).toBe(0);
  });

  it("ignores Greptile inline comments pinned to a stale commit on current HEAD", () => {
    const findings = evaluateInlineReviewThreads(
      [
        thread({
          comments: [
            {
              authorLogin: "greptile-apps[bot]",
              body: INLINE_P1_BODY,
              path: "server/src/cli/program.ts",
              commitOid: OLD,
            },
          ],
        }),
      ],
      HEAD,
    );
    expect(findings.p1Count).toBe(0);
  });

  it("ignores non-Greptile inline comments", () => {
    const findings = evaluateInlineReviewThreads(
      [
        thread({
          comments: [
            {
              authorLogin: "deft-slizard[bot]",
              body: "**P1** inline from SLizard",
              path: "server/src/register/github.ts",
              commitOid: HEAD,
            },
          ],
        }),
      ],
      HEAD,
    );
    expect(findings.p1Count).toBe(0);
  });
});

describe("fetchUnresolvedGreptileInlineFindings", () => {
  it("parses GraphQL reviewThreads payload", () => {
    const payload = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  isResolved: false,
                  isOutdated: false,
                  comments: {
                    nodes: [
                      {
                        author: { login: "greptile-apps[bot]" },
                        body: INLINE_P1_BODY,
                        path: "server/src/register/github.ts",
                        commit: { oid: HEAD },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    };
    const runGh: RunGhFn = (cmd) => {
      expect(cmd.join(" ")).toContain("graphql");
      return { returncode: 0, stdout: JSON.stringify(payload), stderr: "" };
    };
    const findings = fetchUnresolvedGreptileInlineFindings(120, "deftai/statusreport", HEAD, runGh);
    expect(findings.p1Count).toBe(1);
    expect(findings.error).toBeNull();
  });

  it("surfaces GraphQL transport errors", () => {
    const runGh: RunGhFn = () => ({ returncode: 1, stdout: "", stderr: "rate limit" });
    const findings = fetchUnresolvedGreptileInlineFindings(120, "deftai/statusreport", HEAD, runGh);
    expect(findings.error).toContain("graphql reviewThreads failed");
  });

  it("fails closed when pagination reports hasNextPage without endCursor", () => {
    const payload = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: true, endCursor: null },
              nodes: [],
            },
          },
        },
      },
    };
    const runGh: RunGhFn = () => ({ returncode: 0, stdout: JSON.stringify(payload), stderr: "" });
    const findings = fetchUnresolvedGreptileInlineFindings(120, "deftai/statusreport", HEAD, runGh);
    expect(findings.error).toContain("missing endCursor");
  });
});

describe("fetchGreptilePullCommentsRest (#4289)", () => {
  it("counts HEAD-pinned Greptile P1 from REST pulls comments", () => {
    const runGh: RunGhFn = () => ({
      returncode: 0,
      stdout: JSON.stringify([
        {
          user: { login: "greptile-apps[bot]" },
          body: INLINE_P1_BODY,
          commit_id: HEAD,
        },
      ]),
      stderr: "",
    });
    const findings = fetchGreptilePullCommentsRest(4292, "deftai/directive", HEAD, runGh);
    expect(findings.error).toBeNull();
    expect(findings.p1Count).toBeGreaterThanOrEqual(1);
  });

  it("returns error when REST fails", () => {
    const runGh: RunGhFn = () => ({ returncode: 1, stdout: "", stderr: "nope" });
    const findings = fetchGreptilePullCommentsRest(4292, "deftai/directive", HEAD, runGh);
    expect(findings.error).toContain("REST pulls comments failed");
  });

  it("uses gh api --paginate so later pages are scored (#4289)", () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      user: { login: "human" },
      body: `note ${i}`,
      commit_id: HEAD,
    }));
    const page2 = [
      {
        user: { login: "greptile-apps[bot]" },
        body: INLINE_P1_BODY,
        commit_id: HEAD,
      },
    ];
    const runGh: RunGhFn = (cmd) => {
      expect(cmd).toContain("--paginate");
      return { returncode: 0, stdout: JSON.stringify([...page1, ...page2]), stderr: "" };
    };
    const findings = fetchGreptilePullCommentsRest(4292, "deftai/directive", HEAD, runGh);
    expect(findings.error).toBeNull();
    expect(findings.p1Count).toBeGreaterThanOrEqual(1);
  });

  it("decodes concatenated --paginate arrays (#4289)", () => {
    const page1 = JSON.stringify([{ user: { login: "human" }, body: "note", commit_id: HEAD }]);
    const page2 = JSON.stringify([
      {
        user: { login: "greptile-apps[bot]" },
        body: INLINE_P1_BODY,
        commit_id: HEAD,
      },
    ]);
    const runGh: RunGhFn = (cmd) => {
      expect(cmd).toContain("--paginate");
      return { returncode: 0, stdout: page1 + page2, stderr: "" };
    };
    const findings = fetchGreptilePullCommentsRest(4292, "deftai/directive", HEAD, runGh);
    expect(findings.error).toBeNull();
    expect(findings.p1Count).toBeGreaterThanOrEqual(1);
  });
});

describe("loadThinHtmlInlineFindings (#4289)", () => {
  it("prefers GraphQL lifecycle over REST matching-HEAD comments", () => {
    const graphqlPayload = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  isResolved: true,
                  isOutdated: false,
                  comments: {
                    nodes: [
                      {
                        author: { login: "greptile-apps[bot]" },
                        body: INLINE_P1_BODY,
                        path: "greptile-inline.ts",
                        commit: { oid: HEAD },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    };
    const runGh: RunGhFn = (cmd) => {
      const joined = cmd.join(" ");
      if (joined.includes("graphql")) {
        return { returncode: 0, stdout: JSON.stringify(graphqlPayload), stderr: "" };
      }
      return {
        returncode: 0,
        stdout: JSON.stringify([
          {
            user: { login: "greptile-apps[bot]" },
            body: INLINE_P1_BODY,
            commit_id: HEAD,
          },
        ]),
        stderr: "",
      };
    };
    const findings = loadThinHtmlInlineFindings(4303, "deftai/directive", HEAD, runGh);
    expect(findings.error).toBeNull();
    expect(findings.p1Count).toBe(0);
  });

  it("falls back to paginated REST when GraphQL fails", () => {
    const runGh: RunGhFn = (cmd) => {
      const joined = cmd.join(" ");
      if (joined.includes("graphql")) {
        return { returncode: 1, stdout: "", stderr: "rate limit" };
      }
      return {
        returncode: 0,
        stdout: JSON.stringify([
          {
            user: { login: "greptile-apps[bot]" },
            body: INLINE_P1_BODY,
            commit_id: HEAD,
          },
        ]),
        stderr: "",
      };
    };
    const findings = loadThinHtmlInlineFindings(4303, "deftai/directive", HEAD, runGh);
    expect(findings.error).toBeNull();
    expect(findings.p1Count).toBeGreaterThanOrEqual(1);
  });
});
