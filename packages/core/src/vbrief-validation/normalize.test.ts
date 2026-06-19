import { describe, expect, it } from "vitest";
import {
  normalizeFixturePaths,
  sortedDiagnostics,
  sortFailureActions,
  sortFailureStderr,
  splitLines,
} from "./normalize.js";

describe("normalize", () => {
  it("splitLines matches Python splitlines trailing newline", () => {
    expect(splitLines("## Only\n\nBody\n")).toEqual(["## Only", "", "Body"]);
  });

  it("normalizeFixturePaths replaces fixture root", () => {
    expect(normalizeFixturePaths("/tmp/fix/vbrief/x", "/tmp/fix")).toBe("<FIXTURE>/vbrief/x");
  });

  it("sortedDiagnostics sorts errors", () => {
    expect(sortedDiagnostics(["b", "a"], ["z"]).errors).toEqual(["a", "b"]);
  });

  it("handles empty splitLines and non-string fixture payloads", () => {
    expect(splitLines("")).toEqual([]);
    expect(normalizeFixturePaths(42, "/tmp/fix")).toBe(42);
    expect(sortFailureActions(["HEAD", "TAIL"])).toEqual(["HEAD", "TAIL"]);
    expect(sortFailureStderr("HEAD\nTAIL\n")).toBe("HEAD\nTAIL\n");
  });
});
