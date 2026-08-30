import { describe, expect, it, vi } from "vitest";
import { buildClosingKeywordsCheckArgv, run } from "./verify-closing-keywords.js";

describe("buildClosingKeywordsCheckArgv (#3969)", () => {
  it("uses --pr when GITHUB_PR_NUMBER is set", () => {
    expect(buildClosingKeywordsCheckArgv({ GITHUB_PR_NUMBER: "3960" })).toEqual([
      "--mode",
      "fp",
      "--pr",
      "3960",
    ]);
  });

  it("uses --from-git-range when no PR number is present", () => {
    expect(buildClosingKeywordsCheckArgv({})).toEqual([
      "--mode",
      "fp",
      "--from-git-range",
      "origin/master..HEAD",
    ]);
  });
});

describe("run", () => {
  it("invokes the existing detector with the composed argv", () => {
    const invoke = vi.fn().mockReturnValue(0);
    expect(run(["--allow-known-false-positives", "1"], {}, invoke)).toBe(0);
    expect(invoke).toHaveBeenCalledWith([
      "--mode",
      "fp",
      "--from-git-range",
      "origin/master..HEAD",
      "--allow-known-false-positives",
      "1",
    ]);
  });
});
