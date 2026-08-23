import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluatorWorktreePath,
  sha12Of,
  sinkDir,
  sinkManifestPath,
  sinkVerdictPath,
} from "./paths.js";

describe("issue-eval paths", () => {
  it("builds sink and worktree paths from sha12 and invocation id", () => {
    expect(sha12Of("abc123def4567890")).toBe("abc123def456");
    const sink = sinkDir("/repo", "abc123def456", "inv");
    expect(sink.replace(/\\/g, "/")).toContain(".deft-scratch/issue-eval/abc123def456/inv");
    expect(sinkManifestPath("/repo", "abc123def456", "inv")).toContain("manifest.json");
    expect(sinkVerdictPath("/repo", "abc123def456", "inv", 8)).toContain("issue-8.json");
    expect(evaluatorWorktreePath("/repo", 8, "inv")).toContain("issue-eval-8-inv");
    expect(join("a", "b")).toBeTruthy();
  });
});
