import { describe, expect, it } from "vitest";
import { parseSpecTasks } from "./fidelity.js";
import {
  stripEdgeChars,
  stripLeadingWhitespace,
  stripTrailingChar,
  stripTrailingWhitespace,
} from "./normalize.js";
import { storyQualityIssues } from "./story-quality.js";

const userStoryAccepted = (userStory: string): boolean =>
  !storyQualityIssues({
    title: "t",
    description: "d",
    implementationPlan: "p",
    userStory,
    acceptanceTexts: [],
    acceptanceCountJustification: "",
    swarm: {},
  }).some((i) => i.includes("UserStory must match"));

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

describe("linear USER_STORY recognizer parity", () => {
  it("accepts well-formed user stories (single-line, multi-line, commas, spaces)", () => {
    const valid = [
      "As a maintainer, I want x, so that y.",
      "As an engineer, I want feature, so that benefit.",
      "as a x, i want y, so that z.",
      "As a dev, I want\nmulti line, so that\noutcome.\n",
      "As a dev, I want a, b, c, so that x, y, z.",
      "As a   role,   I   want   cap,   so   that   out.",
      "   As a role, I want cap, so that out.  \n",
      "As a role, I want cap, so that v1.2 ships.",
      "As  a   maintainer ,  I want   x , so   that   y .",
    ];
    for (const story of valid) {
      expect(userStoryAccepted(story), story).toBe(true);
    }
  });

  it("rejects malformed user stories", () => {
    const invalid = [
      "",
      "As a role, I want cap, so that out", // missing trailing period
      "As a role, I want cap.", // missing so-that clause
      "As a role, so that out.", // missing want clause
      "I want cap, As a role, so that out.", // wrong order
      "As animal, I want cap, so that out.", // "As a" not followed by whitespace
      "As a role, I want , so that out.", // empty capability
      "As a role, I want cap, so that .", // empty outcome
      "As a role, I want cap, so that out.x", // junk after terminator
      "As a, I want y, so that z.", // no whitespace after "a" before role
    ];
    for (const story of invalid) {
      expect(userStoryAccepted(story), story).toBe(false);
    }
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
