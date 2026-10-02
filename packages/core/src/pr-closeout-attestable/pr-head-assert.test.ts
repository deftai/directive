import { describe, expect, it } from "vitest";
import { assertWorkingTreeIsPrHead, fetchPrHeadShaViaApi, shasMatch } from "./pr-head-assert.js";

describe("pr-head-assert helpers (#3875)", () => {
  it("matches full and abbreviated SHAs either way", () => {
    const full = "abcdef0123456789abcdef0123456789abcdef01";
    expect(shasMatch(full, full.slice(0, 7))).toBe(true);
    expect(shasMatch(full.slice(0, 7), full)).toBe(true);
    expect(shasMatch(full, "deadbeef")).toBe(false);
    expect(shasMatch("", full)).toBe(false);
    expect(shasMatch("abc", full)).toBe(false);
  });

  it("parses head.sha from pulls JSON", () => {
    const sha = "d".repeat(40);
    const runGh = () => ({
      returncode: 0,
      stdout: JSON.stringify({ head: { sha } }),
      stderr: "",
    });
    expect(fetchPrHeadShaViaApi(12, "deftai/directive", runGh)).toBe(sha);
  });

  it("returns null when pulls JSON is missing head.sha", () => {
    const runGh = () => ({
      returncode: 0,
      stdout: JSON.stringify({ head: {} }),
      stderr: "",
    });
    expect(fetchPrHeadShaViaApi(12, "deftai/directive", runGh)).toBeNull();
  });

  it("assertWorkingTreeIsPrHead fails closed on mismatch", () => {
    const result = assertWorkingTreeIsPrHead(
      "/tmp/unused",
      7,
      "deftai/directive",
      () => {
        throw new Error("runGh must not be called");
      },
      { localHeadSha: "a".repeat(40), prHeadSha: "b".repeat(40) },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("is not PR #7 head");
    }
  });

  it("assertWorkingTreeIsPrHead can be disabled for seams", () => {
    const result = assertWorkingTreeIsPrHead(
      "/tmp/unused",
      7,
      "deftai/directive",
      () => {
        throw new Error("runGh must not be called");
      },
      { enabled: false },
    );
    expect(result.ok).toBe(true);
  });

  it("refuses a dirty lifecycle tree on the matched PR head", () => {
    const result = assertWorkingTreeIsPrHead(
      "/tmp/unused",
      7,
      "deftai/directive",
      () => {
        throw new Error("runGh must not be called");
      },
      {
        localHeadSha: "a".repeat(40),
        prHeadSha: "a".repeat(40),
        checkLifecycleDirty: true,
        resolveLifecycleDirty: () => "?? xbrief/active/story.xbrief.json",
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("uncommitted xbrief/vbrief");
    }
  });

  it("resolves a linked worktree when caller HEAD is not the PR head", () => {
    const prHead = "b".repeat(40);
    const result = assertWorkingTreeIsPrHead(
      "/tmp/primary",
      7,
      "deftai/directive",
      () => {
        throw new Error("runGh must not be called");
      },
      {
        localHeadSha: "a".repeat(40),
        prHeadSha: prHead,
        resolveWorktreeAtSha: () => "/tmp/pr-worktree",
        resolveLocalHeadSha: (root) => (root === "/tmp/pr-worktree" ? prHead : "a".repeat(40)),
        resolveLifecycleDirty: () => null,
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedProjectRoot).toBe("/tmp/pr-worktree");
      expect(result.localHeadSha).toBe(prHead);
    }
  });
});
