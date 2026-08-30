import { describe, expect, it, vi } from "vitest";
import {
  buildClosingKeywordsCheckArgv,
  type RunGitFn,
  resolveClosingKeywordsSource,
  run,
} from "./verify-closing-keywords.js";

const mergeBaseGit: RunGitFn = (args) => {
  if (args[0] === "merge-base" && args[1] === "origin/master") {
    return { returncode: 0, stdout: "abc1234def\n", stderr: "" };
  }
  return { returncode: 128, stdout: "", stderr: "not a valid object" };
};

describe("resolveClosingKeywordsSource (#3969)", () => {
  it("uses --pr when GITHUB_PR_NUMBER is set", () => {
    expect(resolveClosingKeywordsSource({ GITHUB_PR_NUMBER: "3960" }, mergeBaseGit)).toEqual({
      kind: "pr",
      pr: "3960",
    });
  });

  it("uses a merge-base range instead of hardcoded origin/master..HEAD", () => {
    expect(resolveClosingKeywordsSource({}, mergeBaseGit)).toEqual({
      kind: "range",
      range: "abc1234def..HEAD",
    });
  });

  it("reports missing-base when no base ref can be merged", () => {
    const none: RunGitFn = () => ({ returncode: 128, stdout: "", stderr: "unknown" });
    const result = resolveClosingKeywordsSource({}, none);
    expect(result.kind).toBe("missing-base");
  });
});

describe("buildClosingKeywordsCheckArgv (#3969)", () => {
  it("uses --pr when GITHUB_PR_NUMBER is set", () => {
    expect(
      buildClosingKeywordsCheckArgv({ GITHUB_PR_NUMBER: "3960" }, [], mergeBaseGit).argv,
    ).toEqual(["--mode", "fp", "--pr", "3960"]);
  });

  it("uses --from-git-range against the merge-base when no PR number is present", () => {
    expect(buildClosingKeywordsCheckArgv({}, [], mergeBaseGit).argv).toEqual([
      "--mode",
      "fp",
      "--from-git-range",
      "abc1234def..HEAD",
    ]);
  });
});

describe("run", () => {
  it("invokes the existing detector with the composed argv", () => {
    const invoke = vi.fn().mockReturnValue(0);
    expect(run(["--allow-known-false-positives", "1"], {}, invoke, mergeBaseGit)).toBe(0);
    expect(invoke).toHaveBeenCalledWith([
      "--mode",
      "fp",
      "--from-git-range",
      "abc1234def..HEAD",
      "--allow-known-false-positives",
      "1",
    ]);
  });

  it("does not fall back to a stale local master", () => {
    const git: RunGitFn = (args) => {
      if (args[0] === "merge-base" && args[1] === "master") {
        return { returncode: 0, stdout: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n", stderr: "" };
      }
      return { returncode: 128, stdout: "", stderr: "unknown" };
    };
    expect(resolveClosingKeywordsSource({}, git).kind).toBe("missing-base");
  });

  it("fails closed with exit 2 when no merge-base exists", () => {
    const invoke = vi.fn().mockReturnValue(1);
    const none: RunGitFn = () => ({ returncode: 128, stdout: "", stderr: "unknown" });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(run([], {}, invoke, none)).toBe(2);
    expect(invoke).not.toHaveBeenCalled();
    expect(stderr.mock.calls.join("")).toContain("fail --");
    expect(stderr.mock.calls.join("")).toContain("git fetch origin master");
    stderr.mockRestore();
  });
});
