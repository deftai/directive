import { describe, expect, it } from "vitest";
import {
  evaluateInlineReviewThreads,
  fetchUnresolvedGreptileInlineFindings,
  headShaMatches,
  type InlineReviewThread,
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
