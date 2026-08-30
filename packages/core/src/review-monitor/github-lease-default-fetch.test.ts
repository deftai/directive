import { describe, expect, it, vi } from "vitest";

const spawnSync = vi.hoisted(() => vi.fn());

vi.mock("../scm/binary.js", () => ({
  resolveBinary: () => "gh",
  defaultWhich: (name: string) => (name === "gh" ? "gh" : null),
}));

vi.mock("../scm/call-shape.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scm/call-shape.js")>();
  return {
    ...actual,
    resolveBinaryForArgv: () => "gh",
  };
});

vi.mock("node:child_process", () => ({
  spawnSync,
}));

import { listReviewOwnerComments } from "./github-lease.js";
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

describe("github-lease default fetch path (#2814 / #2836)", () => {
  it("surfaces spawn errors from gh api", () => {
    spawnSync.mockReturnValueOnce({
      error: new Error("spawn ENOENT"),
      status: null,
      stderr: "",
      stdout: "",
    });
    expect(
      listReviewOwnerComments("deftai/directive", 1, {
        whichFn: () => "gh",
      }),
    ).toEqual({
      error: "fetch PR #1 comments (deftai/directive) failed: spawn ENOENT",
    });
  });

  it("surfaces non-zero gh exit status", () => {
    spawnSync.mockReturnValueOnce({
      status: 1,
      stderr: "rate limited",
      stdout: "",
    });
    expect(
      listReviewOwnerComments("deftai/directive", 2, {
        whichFn: () => "gh",
      }),
    ).toEqual({
      error: "fetch PR #2 comments (deftai/directive) failed: rate limited",
    });
  });

  it("surfaces non-JSON gh stdout", () => {
    spawnSync.mockReturnValueOnce({
      status: 0,
      stderr: "",
      stdout: "[{broken",
    });
    expect(
      listReviewOwnerComments("deftai/directive", 3, {
        whichFn: () => "gh",
      }),
    ).toEqual({
      error: expect.stringMatching(/returned non-JSON/),
    });
  });

  it("maps maintainer comments from gh stdout", () => {
    spawnSync.mockReturnValueOnce({
      status: 0,
      stderr: "",
      stdout: JSON.stringify([
        {
          id: 9,
          body: LEASE_BODY,
          updated_at: "2026-07-24T12:00:00.000Z",
          author_association: "MEMBER",
        },
      ]),
    });
    const result = listReviewOwnerComments("deftai/directive", 4, {
      whichFn: () => "gh",
    });
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result).toHaveLength(1);
      expect(result[0]?.lease?.owner).toBe("alice");
    }
  });
});
