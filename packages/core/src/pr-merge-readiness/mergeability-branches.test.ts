import { describe, expect, it } from "vitest";
import { fetchMergeability } from "./mergeability.js";

describe("mergeability branch coverage (#2666)", () => {
  it("fetchMergeability stringifies non-Error JSON parse failures", () => {
    const signal = fetchMergeability(1, "deftai/directive", () => ({
      returncode: 0,
      stdout: "{not-json",
      stderr: "",
    }));
    expect(signal.error).toMatch(/could not parse PR JSON/);
    expect(signal.mergeable).toBeNull();
  });

  it("fetchMergeability reports empty gh api bodies", () => {
    const signal = fetchMergeability(2, "deftai/directive", () => ({
      returncode: 0,
      stdout: "   ",
      stderr: "",
    }));
    expect(signal.error).toBe("empty body from gh api /pulls/<N>");
  });

  it("fetchMergeability reports gh api failures", () => {
    const signal = fetchMergeability(3, "deftai/directive", () => ({
      returncode: 1,
      stdout: "",
      stderr: "rate limit",
    }));
    expect(signal.error).toMatch(/gh api \/pulls\/3 failed/);
  });

  it("fetchMergeability reports unexpected JSON shapes", () => {
    const signal = fetchMergeability(4, "deftai/directive", () => ({
      returncode: 0,
      stdout: "[]",
      stderr: "",
    }));
    expect(signal.error).toBe("unexpected PR JSON shape (not a dict)");
  });
});
