import { describe, expect, it } from "vitest";
import { findHits } from "./detect.js";

describe("negation detection", () => {
  it("flags DOES NOT CLOSE", () => {
    const text = "This PR DOES NOT CLOSE #734 -- the issue stays open.";
    const hits = findHits(text, "pr-body");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.issueNumber).toBe(734);
    expect(hits[0]?.reason).toBe("negation");
  });

  it("flags intentionally not Closes", () => {
    const text = "Intentionally not Closes #642 because it is the umbrella.";
    const hits = findHits(text, "pr-body");
    expect(hits.some((h) => h.reason === "negation" && h.issueNumber === 642)).toBe(true);
  });

  it("flags never Fixes", () => {
    const text = "We never Fixes #100 in this PR; that is deferred to v2.";
    const hits = findHits(text, "pr-body");
    expect(hits.some((h) => h.reason === "negation" && h.issueNumber === 100)).toBe(true);
  });

  it("flags won't and cannot negation markers", () => {
    expect(findHits("We won't Fixes #88 today.", "pr-body").some((h) => h.issueNumber === 88)).toBe(
      true,
    );
    expect(
      findHits("You cannot Closes #89 here.", "pr-body").some((h) => h.issueNumber === 89),
    ).toBe(true);
  });

  it("flags EXCEPT marker", () => {
    expect(
      findHits("All issues EXCEPT Closes #90 stay open.", "pr-body").some(
        (h) => h.issueNumber === 90,
      ),
    ).toBe(true);
  });
});

describe("quotation detection", () => {
  it("flags backticked closing keyword", () => {
    const text = "Note: do not write `Closes #642` in the body.";
    const hits = findHits(text, "pr-body");
    expect(hits).toHaveLength(1);
    expect(["quotation", "negation"]).toContain(hits[0]?.reason);
    expect(hits[0]?.issueNumber).toBe(642);
  });

  it("flags curly-quoted closing keyword", () => {
    const text = "Avoid \u201cCloses #77\u201d in prose.";
    const hits = findHits(text, "pr-body");
    expect(hits.some((h) => h.reason === "quotation" && h.issueNumber === 77)).toBe(true);
  });
});

describe("example detection", () => {
  it("flags e.g. Closes", () => {
    const text = "Use a closing keyword (e.g. Closes #100) only when intended.";
    const hits = findHits(text, "pr-body");
    expect(hits.some((h) => h.reason === "example" && h.issueNumber === 100)).toBe(true);
  });

  it("flags for example Closes", () => {
    const text = "For example, Closes #234 would auto-close on merge.";
    const hits = findHits(text, "pr-body");
    expect(hits.some((h) => h.issueNumber === 234)).toBe(true);
  });

  it("flags i.e. and such as markers", () => {
    expect(
      findHits("Only when intended (i.e. Closes #301) should it fire.", "pr-body").some(
        (h) => h.issueNumber === 301,
      ),
    ).toBe(true);
    expect(
      findHits("Avoid tokens such as Closes #302 in docs.", "pr-body").some(
        (h) => h.issueNumber === 302,
      ),
    ).toBe(true);
  });
});

describe("code block detection", () => {
  it("flags triple-backtick fenced keyword", () => {
    const text = "Documentation example:\n```\nCloses #500\n```\nEnd example.";
    const hits = findHits(text, "pr-body");
    expect(hits.some((h) => h.reason === "code-block" && h.issueNumber === 500)).toBe(true);
  });
});

describe("blockquote detection", () => {
  it("flags blockquote keyword", () => {
    const text = "Body intro.\n> Closes #42 must not appear here.\nMore body.";
    const hits = findHits(text, "pr-body");
    expect(hits.some((h) => h.reason === "blockquote" && h.issueNumber === 42)).toBe(true);
  });
});

describe("true positive control", () => {
  it("returns no hits for legit Closes", () => {
    const text = "feat(core): land the gate.\n\nCloses #734\n\nDescription continues...";
    expect(findHits(text, "pr-body")).toEqual([]);
  });

  it("returns no hits when no keyword present", () => {
    const text = "Refs #642 (umbrella; remains open).";
    expect(findHits(text, "pr-body")).toEqual([]);
  });
});
