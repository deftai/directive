import { describe, expect, it } from "vitest";
import { parseSpecTasks } from "./fidelity.js";
import {
  stripEdgeChars,
  stripLeadingWhitespace,
  stripTrailingChar,
  stripTrailingWhitespace,
} from "./normalize.js";

describe("ReDoS-free normalize helpers", () => {
  it("strips trailing whitespace exactly like /\\s+$/", () => {
    expect(stripTrailingWhitespace("a \t\n")).toBe("a");
    expect(stripTrailingWhitespace("   ")).toBe("");
    expect(stripTrailingWhitespace("ab")).toBe("ab");
    expect(stripTrailingWhitespace("")).toBe("");
  });

  it("strips leading whitespace exactly like /^\\s+/", () => {
    expect(stripLeadingWhitespace(" \t x")).toBe("x");
    expect(stripLeadingWhitespace("y")).toBe("y");
    expect(stripLeadingWhitespace("   ")).toBe("");
  });

  it("strips edge characters from a set", () => {
    expect(stripEdgeChars("--a-b--", "-")).toBe("a-b");
    expect(stripEdgeChars("`*x;`", "`*,;. ")).toBe("x");
    expect(stripEdgeChars("----", "-")).toBe("");
    expect(stripEdgeChars("abc", "-")).toBe("abc");
  });

  it("strips a trailing repeated character", () => {
    expect(stripTrailingChar("a///", "/")).toBe("a");
    expect(stripTrailingChar("///", "/")).toBe("");
    expect(stripTrailingChar("abc", "/")).toBe("abc");
  });
});

describe("parseSpecTasks heading + body parser branches", () => {
  it("rejects malformed headings without throwing", () => {
    const spec = [
      "###t1.1.1 no space after hashes",
      "### x1.1.1 not a t id",
      "### t.1 missing leading digits",
      "### t1.x dot without digit",
      "### t1.1.1nodelim",
      "### t1.1.1 a []",
      "### t1.1.1 a [ab cd]",
      "##### t9.9.9 five hashes",
    ].join("\n");
    expect(parseSpecTasks(spec)).toEqual([]);
  });

  it("parses separator and bracket-status edge headings", () => {
    const dashOnly = parseSpecTasks("### t1.1.1 -\n");
    expect(dashOnly[0]?.title).toBe("-");
    const dashBracket = parseSpecTasks("### t2.2.2 -[done]\n");
    expect(dashBracket[0]?.title).toBe("-");
    expect(dashBracket[0]?.status).toBe("completed");
  });

  it("ignores non-matching Depends/Traces body lines", () => {
    const spec = [
      "### t1.1.1 Title",
      "",
      "Depends off: t9.9.9",
      "Depends on t9.9.9",
      "Depends on:",
      "Traces FR-1",
      "Traces:",
      "",
    ].join("\n");
    const task = parseSpecTasks(spec)[0];
    expect(task?.depends_on).toEqual([]);
    expect(task?.traces).toEqual([]);
  });
});
