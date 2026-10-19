import { describe, expect, it } from "vitest";
import { findAllClosingKeywordHits, findHits, hasFullCloseIntent } from "./detect.js";

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
  it("returns no FP hits for legit Closes (FP mode only)", () => {
    const text = "feat(core): land the gate.\n\nCloses #734\n\nDescription continues...";
    expect(findHits(text, "pr-body")).toEqual([]);
  });

  it("returns no hits when no keyword present", () => {
    const text = "Refs #642 (umbrella; remains open).";
    expect(findHits(text, "pr-body")).toEqual([]);
  });
});

describe("intent mode (#3015 class D)", () => {
  it("flags bare Closes as intent", () => {
    const text = "feat(core): land the gate.\n\nCloses #734\n\nDescription continues...";
    const hits = findAllClosingKeywordHits(text, "pr-body");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.reason).toBe("intent");
    expect(hits[0]?.issueNumber).toBe(734);
  });

  it("flags enterprize PR #30-style conditional Closes", () => {
    // Exact shape from enterprize PR #30 (class D premature complete of multi-phase #29).
    const text =
      "Closes #29 Phase A intake only if you want intake closed on merge — otherwise leave #29 open for Phase B/C distill.";
    const hits = findAllClosingKeywordHits(text, "pr-body");
    expect(hits.some((h) => h.issueNumber === 29 && h.reason === "intent")).toBe(true);
    // FP mode must still pass (class split documentation: class D ≠ class A)
    expect(findHits(text, "pr-body")).toEqual([]);
  });

  it("never authorizes via body trailer text (CLI --allow-close only)", () => {
    expect(hasFullCloseIntent("Closes #1\n\ndeft-close-intent: full\n")).toBe(false);
    expect(hasFullCloseIntent("Closes #1\n")).toBe(false);
    expect(hasFullCloseIntent("  deft-close-intent: full  ")).toBe(false);
  });
});

describe("comma-list closer-set (#4494)", () => {
  it("counts each origin in Closes #4204, #4218, …", () => {
    const hits = findAllClosingKeywordHits("Closes #4204, #4218, #4161, #3918, #3849", "pr-body");
    expect(hits.filter((h) => h.reason === "intent").map((h) => h.issueNumber)).toEqual([
      4204, 4218, 4161, 3918, 3849,
    ]);
  });
});

describe("comma-list monotonic scanner (#5745 / CodeQL alert #121)", () => {
  it("keeps long valid whitespace padding between commas", () => {
    const pad = " ".repeat(4000);
    const text = `Closes #10,${pad}#20,${pad}#30`;
    expect(
      findAllClosingKeywordHits(text, "pr-body")
        .filter((h) => h.reason === "intent")
        .map((h) => h.issueNumber),
    ).toEqual([10, 20, 30]);
  });

  it("accepts tabs and newlines as ECMAScript whitespace around commas", () => {
    const text = "Closes #11,\t#22,\n#33";
    expect(
      findAllClosingKeywordHits(text, "pr-body")
        .filter((h) => h.reason === "intent")
        .map((h) => h.issueNumber),
    ).toEqual([11, 22, 33]);
  });

  it("keeps a long valid list without truncating later IDs", () => {
    const ids = Array.from({ length: 40 }, (_, i) => 1000 + i);
    const text = `Closes #${ids[0]}, ${ids
      .slice(1)
      .map((n) => `#${n}`)
      .join(", ")}`;
    expect(
      findAllClosingKeywordHits(text, "pr-body")
        .filter((h) => h.reason === "intent")
        .map((h) => h.issueNumber),
    ).toEqual(ids);
  });

  it("keeps the valid prefix and stops at a malformed tail", () => {
    const text = "Closes #7, #8, #not-a-number, #9";
    expect(
      findAllClosingKeywordHits(text, "pr-body")
        .filter((h) => h.reason === "intent")
        .map((h) => h.issueNumber),
    ).toEqual([7, 8]);
  });

  it("stops before an unrelated later #ID after a break", () => {
    const text = "Closes #41, #42 then later mention #99 in prose";
    expect(
      findAllClosingKeywordHits(text, "pr-body")
        .filter((h) => h.reason === "intent")
        .map((h) => h.issueNumber),
    ).toEqual([41, 42]);
  });

  it("inherits FP classification for comma-list tails", () => {
    const text = "Intentionally not Closes #50, #51 in this body.";
    const hits = findHits(text, "pr-body");
    expect(hits.map((h) => h.issueNumber)).toEqual([50, 51]);
    expect(hits.every((h) => h.reason === "negation")).toBe(true);
  });

  it("inherits intent classification for comma-list tails", () => {
    const text = "Closes #60, #61\n\nDescription continues.";
    const hits = findAllClosingKeywordHits(text, "pr-body");
    expect(hits.map((h) => h.issueNumber)).toEqual([60, 61]);
    expect(hits.every((h) => h.reason === "intent")).toBe(true);
  });
});
