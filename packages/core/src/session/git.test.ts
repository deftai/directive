import { describe, expect, it } from "vitest";
import { detectBranch, gitHead, worktreePath } from "./git.js";

describe("session git helpers", () => {
  it("gitHead returns error when git missing", () => {
    const result = gitHead("/tmp", () => ({ code: 127, stdout: "", stderr: "missing" }));
    expect(result.head).toBeNull();
    expect(result.error).toBe("missing");
  });

  it("worktreePath falls back to project root", () => {
    expect(worktreePath("/tmp/project", () => ({ code: 1, stdout: "", stderr: "" }))).toContain(
      "project",
    );
  });

  it("detectBranch uses detached sha fallback", () => {
    const branch = detectBranch("/tmp", (_r, args) => {
      if (args[0] === "symbolic-ref") return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--short") {
        return { code: 0, stdout: "abc1234", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    });
    expect(branch).toBe("detached:abc1234");
  });

  it("detectBranch returns null when git unavailable", () => {
    expect(detectBranch("/tmp", () => ({ code: 127, stdout: "", stderr: "" }))).toBeNull();
  });
});
