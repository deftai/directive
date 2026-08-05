import { describe, expect, it } from "vitest";
import {
  countRepeatedUnitsInBlob,
  DEFAULT_MAX_IDENTICAL_WITHOUT_TOOL,
  evaluateParentTurnShape,
  isNearIdentical,
  isTextRepetitionHang,
  normalizeTurnText,
  PARENT_TURN_FAIL_FC14,
  type ParentTurnEvent,
  splitTextUnits,
} from "./evaluate.js";

const PROGRESS = "Checking worktrees and open PRs next to confirm leaf completion status.";

describe("normalizeTurnText / splitTextUnits / isNearIdentical", () => {
  it("normalizes case whitespace and trailing punctuation", () => {
    expect(normalizeTurnText("  Hello World!!! ")).toBe("hello world");
  });

  it("splits on sentence boundaries and blank lines", () => {
    const units = splitTextUnits("One sentence. Two sentence.\n\nThree block.");
    expect(units.length).toBeGreaterThanOrEqual(3);
  });

  it("treats punctuation-only variance as near-identical", () => {
    expect(
      isNearIdentical(
        "Checking worktrees and open PRs next.",
        "Checking worktrees and open PRs next!",
      ),
    ).toBe(true);
  });

  it("does not match short units", () => {
    expect(isNearIdentical("ok.", "ok!")).toBe(false);
  });
});

describe("evaluateParentTurnShape — legal shapes", () => {
  it("allows a single short user answer with no tools", () => {
    const result = evaluateParentTurnShape({
      events: [{ kind: "assistant_text", text: "Two leaves still open; waiting on CI." }],
      afterSubagentAnnounce: true,
    });
    expect(result.ok).toBe(true);
    expect(result.failClass).toBe("none");
  });

  it("allows tool-first ground-truth batch (tool greases the turn)", () => {
    const events: ParentTurnEvent[] = [
      { kind: "assistant_text", text: PROGRESS },
      { kind: "tool_use", name: "gh" },
      { kind: "assistant_text", text: PROGRESS },
      { kind: "assistant_text", text: PROGRESS },
      { kind: "assistant_text", text: "PR #1 is open on HEAD abc." },
    ];
    const result = evaluateParentTurnShape({ events, afterSubagentAnnounce: true });
    expect(result.ok).toBe(true);
    expect(result.hasToolUse).toBe(true);
  });

  it("allows sessions_yield with no user filler", () => {
    const result = evaluateParentTurnShape({
      events: [{ kind: "yield" }],
      afterSubagentAnnounce: true,
    });
    expect(result.ok).toBe(true);
    expect(result.hasYield).toBe(true);
  });

  it("allows up to maxIdenticalWithoutTool identical lines (default 2)", () => {
    const result = evaluateParentTurnShape({
      events: [
        { kind: "assistant_text", text: PROGRESS },
        { kind: "assistant_text", text: PROGRESS },
      ],
    });
    expect(DEFAULT_MAX_IDENTICAL_WITHOUT_TOOL).toBe(2);
    expect(result.ok).toBe(true);
    expect(result.maxIdenticalCount).toBe(2);
  });
});

describe("evaluateParentTurnShape — hard-stop (FC14)", () => {
  it("fails N>2 identical progress lines with zero tools (repro hang)", () => {
    const events: ParentTurnEvent[] = [
      { kind: "assistant_text", text: PROGRESS },
      { kind: "assistant_text", text: PROGRESS },
      { kind: "assistant_text", text: PROGRESS },
    ];
    const result = evaluateParentTurnShape({ events, afterSubagentAnnounce: true });
    expect(result.ok).toBe(false);
    expect(result.failClass).toBe(PARENT_TURN_FAIL_FC14);
    expect(result.maxIdenticalCount).toBeGreaterThan(2);
    expect(result.reasons.join(" ")).toMatch(/FC14|text-repetition-hang/i);
    expect(result.reasons.join(" ")).toMatch(/#3131/);
    expect(isTextRepetitionHang({ events })).toBe(true);
  });

  it("fails a single blob that embeds the same sentence many times", () => {
    const blob = Array.from({ length: 20 }, () => PROGRESS).join(" ");
    const result = evaluateParentTurnShape({
      events: [{ kind: "assistant_text", text: blob }],
    });
    expect(result.ok).toBe(false);
    expect(result.failClass).toBe("FC14");
    expect(countRepeatedUnitsInBlob(blob)).toBeGreaterThan(2);
  });

  it("splits block-formatted newline repeats without sentence punctuation", () => {
    const blob = [PROGRESS, PROGRESS, PROGRESS].join("\n");
    const units = splitTextUnits(blob);
    expect(units.length).toBeGreaterThanOrEqual(3);
    const result = evaluateParentTurnShape({
      events: [{ kind: "assistant_text", text: blob }],
    });
    expect(result.ok).toBe(false);
    expect(result.failClass).toBe("FC14");
  });

  it("fails exactly two post-announce progress-only sentences", () => {
    const result = evaluateParentTurnShape({
      afterSubagentAnnounce: true,
      events: [
        {
          kind: "assistant_text",
          text: "Checking worktrees next for leaf status. Will inspect open PRs after that.",
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(["FC14", "progress-only-no-tool"]).toContain(result.failClass);
  });

  it("fails post-announce multi-sentence progress-only without exact clones", () => {
    const result = evaluateParentTurnShape({
      afterSubagentAnnounce: true,
      events: [
        {
          kind: "assistant_text",
          text:
            "Two leaves look unfinished right now. " +
            "Checking worktrees next for status. " +
            "Will inspect open PRs after that. " +
            "Monitoring both before I decide.",
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(["FC14", "progress-only-no-tool"]).toContain(result.failClass);
  });

  it("does not hard-stop when yield is present even with repeated text", () => {
    const result = evaluateParentTurnShape({
      events: [
        { kind: "assistant_text", text: PROGRESS },
        { kind: "assistant_text", text: PROGRESS },
        { kind: "assistant_text", text: PROGRESS },
        { kind: "yield" },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("reconstructs fragmented streaming word deltas of a repeated sentence", () => {
    // Host streams one repeated progress line as word-sized assistant_text events.
    const words = PROGRESS.split(/(\s+)/).filter((w) => w.length > 0);
    const events: ParentTurnEvent[] = [];
    for (let rep = 0; rep < 3; rep++) {
      for (const w of words) {
        events.push({ kind: "assistant_text", text: w });
      }
      events.push({ kind: "assistant_text", text: " " });
    }
    const result = evaluateParentTurnShape({ events, afterSubagentAnnounce: true });
    expect(result.ok).toBe(false);
    expect(result.failClass).toBe("FC14");
    expect(result.maxIdenticalCount).toBeGreaterThan(2);
  });

  it("counts non-consecutive near-identical progress lines with separators", () => {
    const result = evaluateParentTurnShape({
      events: [
        {
          kind: "assistant_text",
          text:
            "Checking worktrees and open PRs next to confirm leaf completion status. " +
            "Other note about cohort size. " +
            "Checking worktrees and open PRs next to confirm leaf completion status! " +
            "Brief aside. " +
            "Checking worktrees and open PRs next to confirm leaf completion status?",
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.failClass).toBe("FC14");
    expect(result.maxIdenticalCount).toBeGreaterThan(2);
  });

  it("clusters non-transitive near-identity wording chains", () => {
    // A≈B and B≈C should cluster as size 3 even if A is slightly farther from C.
    const a =
      "Checking worktrees and open PRs next to confirm the leaf completion status carefully.";
    const b =
      "Checking worktrees and open PRs next to confirm the leaf completion status carefully now.";
    const c =
      "Checking worktrees and open PRs next to confirm the leaf completion status carefully today.";
    const result = evaluateParentTurnShape({
      events: [
        {
          kind: "assistant_text",
          text: `${a} Other note. ${b} Aside. ${c}`,
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.failClass).toBe("FC14");
    expect(result.maxIdenticalCount).toBeGreaterThan(2);
  });
});
