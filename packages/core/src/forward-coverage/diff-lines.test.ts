import { describe, expect, it } from "vitest";
import {
  allLinesChanged,
  countFileLines,
  parseUnifiedDiffAddedLines,
  stripGitDiffPath,
} from "./diff-lines.js";

describe("stripGitDiffPath", () => {
  it("strips the git b/ prefix", () => {
    expect(stripGitDiffPath("b/src/foo.ts")).toBe("src/foo.ts");
  });

  it("strips quoted git paths", () => {
    expect(stripGitDiffPath('"b/src/foo.ts"')).toBe("src/foo.ts");
  });

  it("leaves unprefixed paths intact", () => {
    expect(stripGitDiffPath("src/foo.ts")).toBe("src/foo.ts");
  });

  it("strips single-quoted git paths", () => {
    expect(stripGitDiffPath("'b/src/foo.ts'")).toBe("src/foo.ts");
  });
});

describe("parseUnifiedDiffAddedLines", () => {
  it("collects added lines from a new-file hunk", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/foo.ts",
      "@@ -0,0 +1,3 @@",
      "+a",
      "+b",
      "+c",
      "",
    ].join("\n");
    const map = parseUnifiedDiffAddedLines(diff);
    expect([...(map.get("src/foo.ts") ?? [])].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it("collects only added lines from a modification hunk", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -2,0 +3,2 @@",
      "+added-a",
      "+added-b",
      "",
    ].join("\n");
    const map = parseUnifiedDiffAddedLines(diff);
    expect([...(map.get("src/foo.ts") ?? [])].sort((a, b) => a - b)).toEqual([3, 4]);
  });

  it("ignores deletion-only hunks", () => {
    const diff = [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -4,2 +4,0 @@",
      "-gone",
      "-also",
      "",
    ].join("\n");
    const map = parseUnifiedDiffAddedLines(diff);
    expect([...(map.get("src/foo.ts") ?? [])]).toEqual([]);
  });

  it("skips /dev/null destinations", () => {
    const diff = ["--- a/src/foo.ts", "+++ /dev/null", "@@ -1,1 +0,0 @@", "-x", ""].join("\n");
    expect(parseUnifiedDiffAddedLines(diff).size).toBe(0);
  });

  it("advances the new-file cursor on context lines", () => {
    const diff = [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,2 +1,3 @@",
      " keep",
      "+added",
      " also",
      "",
    ].join("\n");
    const map = parseUnifiedDiffAddedLines(diff);
    expect([...(map.get("src/foo.ts") ?? [])]).toEqual([2]);
  });
});

describe("countFileLines / allLinesChanged", () => {
  it("counts lines without a trailing-split ghost", () => {
    expect(countFileLines("a\nb\n")).toBe(2);
    expect(countFileLines("")).toBe(0);
    expect(countFileLines("solo")).toBe(1);
  });

  it("marks every line of an untracked file as added", () => {
    expect([...allLinesChanged(3)].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });
});
