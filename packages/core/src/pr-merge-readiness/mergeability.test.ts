import { describe, expect, it } from "vitest";
import {
  fetchMergeability,
  isGithubMergeableClean,
  MERGE_STATE_CLEAN,
  mergeabilityToDict,
  verdictBlockIsSoftOnly,
  verdictShaIsStale,
} from "./mergeability.js";
import { emptyVerdict } from "./parse.js";
import type { GreptileVerdict, RunGhFn } from "./types.js";

const HEAD = "abc1234567890def1234567890abcdef12345678";
const OLD = "0000000000000000000000000000000000000000";

function ghReturning(payload: unknown, returncode = 0, stderr = ""): RunGhFn {
  return () => ({
    returncode,
    stdout: typeof payload === "string" ? payload : JSON.stringify(payload),
    stderr,
  });
}

describe("fetchMergeability", () => {
  it("parses mergeable_state and mergeable from REST", () => {
    const signal = fetchMergeability(
      1,
      "o/r",
      ghReturning({ mergeable: true, mergeable_state: "clean" }),
    );
    expect(signal).toEqual({ mergeableState: "clean", mergeable: true, error: null });
  });

  it("returns error on non-zero gh", () => {
    const signal = fetchMergeability(1, "o/r", ghReturning("", 1, "boom"));
    expect(signal.mergeableState).toBeNull();
    expect(signal.mergeable).toBeNull();
    expect(signal.error).toContain("failed");
  });

  it("returns error on empty body", () => {
    const signal = fetchMergeability(1, "o/r", ghReturning("   "));
    expect(signal.error).toContain("empty body");
  });

  it("returns error on invalid JSON", () => {
    const signal = fetchMergeability(1, "o/r", ghReturning("{not json"));
    expect(signal.error).toContain("could not parse");
  });

  it("returns error on non-dict JSON", () => {
    const signal = fetchMergeability(1, "o/r", ghReturning([1, 2, 3]));
    expect(signal.error).toContain("not a dict");
  });

  it("coerces missing fields to null", () => {
    const signal = fetchMergeability(1, "o/r", ghReturning({ state: "open" }));
    expect(signal).toEqual({ mergeableState: null, mergeable: null, error: null });
  });
});

describe("isGithubMergeableClean", () => {
  it("true only when clean + mergeable", () => {
    expect(isGithubMergeableClean({ mergeableState: "clean", mergeable: true, error: null })).toBe(
      true,
    );
  });

  it("false for unstable", () => {
    expect(
      isGithubMergeableClean({ mergeableState: "unstable", mergeable: true, error: null }),
    ).toBe(false);
  });

  it("false when mergeable is null", () => {
    expect(isGithubMergeableClean({ mergeableState: "clean", mergeable: null, error: null })).toBe(
      false,
    );
  });

  it("exposes canonical clean constant", () => {
    expect(MERGE_STATE_CLEAN).toBe("clean");
  });
});

describe("mergeabilityToDict", () => {
  it("serialises snake_case envelope", () => {
    expect(mergeabilityToDict({ mergeableState: "clean", mergeable: true, error: null })).toEqual({
      mergeable_state: "clean",
      mergeable: true,
      error: null,
    });
  });
});

function verdict(overrides: Partial<GreptileVerdict>): GreptileVerdict {
  return { ...emptyVerdict(), ...overrides };
}

describe("verdictShaIsStale", () => {
  it("false when verdict absent", () => {
    expect(verdictShaIsStale(emptyVerdict(), HEAD)).toBe(false);
  });

  it("false when SHAs match by prefix", () => {
    expect(
      verdictShaIsStale(verdict({ found: true, lastReviewedSha: HEAD.slice(0, 12) }), HEAD),
    ).toBe(false);
  });

  it("true when SHAs diverge", () => {
    expect(verdictShaIsStale(verdict({ found: true, lastReviewedSha: OLD }), HEAD)).toBe(true);
  });
});

describe("verdictBlockIsSoftOnly", () => {
  it("absent verdict is soft", () => {
    expect(verdictBlockIsSoftOnly(emptyVerdict(), HEAD)).toBe(true);
  });

  it("stale head SHA without blocker findings is soft", () => {
    expect(
      verdictBlockIsSoftOnly(verdict({ found: true, lastReviewedSha: OLD, confidence: 5 }), HEAD),
    ).toBe(true);
  });

  it("stale head SHA with P0/P1 is a HARD block (#2382)", () => {
    expect(
      verdictBlockIsSoftOnly(
        verdict({ found: true, lastReviewedSha: OLD, p0Count: 3, confidence: 1 }),
        HEAD,
      ),
    ).toBe(false);
  });

  it("stale head SHA with errored is a HARD block (#2382)", () => {
    expect(
      verdictBlockIsSoftOnly(verdict({ found: true, lastReviewedSha: OLD, errored: true }), HEAD),
    ).toBe(false);
  });

  it("excluded-author skip is soft (#2375)", () => {
    expect(
      verdictBlockIsSoftOnly(
        verdict({ found: true, excludedAuthor: true, lastReviewedSha: null, confidence: null }),
        HEAD,
      ),
    ).toBe(true);
  });

  it("current-head P0/P1 is a HARD block", () => {
    expect(
      verdictBlockIsSoftOnly(verdict({ found: true, lastReviewedSha: HEAD, p1Count: 1 }), HEAD),
    ).toBe(false);
  });

  it("current-head errored is a HARD block", () => {
    expect(
      verdictBlockIsSoftOnly(verdict({ found: true, lastReviewedSha: HEAD, errored: true }), HEAD),
    ).toBe(false);
  });

  it("current-head low confidence is a HARD block", () => {
    expect(
      verdictBlockIsSoftOnly(verdict({ found: true, lastReviewedSha: HEAD, confidence: 2 }), HEAD),
    ).toBe(false);
  });

  it("advisory should-not-merge prose is a HARD block even at conf 5 (#3225)", () => {
    expect(
      verdictBlockIsSoftOnly(
        verdict({
          found: true,
          lastReviewedSha: HEAD,
          confidence: 5,
          shouldNotMerge: true,
          p0Count: 0,
          p1Count: 0,
        }),
        HEAD,
      ),
    ).toBe(false);
  });

  it("confidence below resolved dogfood min=5 is a HARD block (#3095)", () => {
    // 4/5 would be soft under consumer default (4) but MUST stay hard when policy/dogfood is 5
    // so GitHub CLEAN reconciliation cannot clear a dogfood confidence holdout.
    expect(
      verdictBlockIsSoftOnly(
        verdict({ found: true, lastReviewedSha: HEAD, confidence: 4 }),
        HEAD,
        null,
        5,
      ),
    ).toBe(false);
    expect(
      verdictBlockIsSoftOnly(
        verdict({ found: true, lastReviewedSha: HEAD, confidence: 4 }),
        HEAD,
        null,
        4,
      ),
    ).toBe(true);
  });

  it("informal-clean is out of scope (not soft)", () => {
    expect(verdictBlockIsSoftOnly(verdict({ found: true, informalClean: true }), HEAD)).toBe(false);
  });

  it("present but missing canonical fields (no findings) is soft", () => {
    expect(verdictBlockIsSoftOnly(verdict({ found: true, lastReviewedSha: HEAD }), HEAD)).toBe(
      true,
    );
  });

  it("unresolved inline P0/P1 is a HARD block (#2620)", () => {
    expect(
      verdictBlockIsSoftOnly(verdict({ found: true, lastReviewedSha: HEAD, confidence: 5 }), HEAD, {
        p0Count: 0,
        p1Count: 1,
        unresolvedThreadCount: 1,
        error: null,
      }),
    ).toBe(false);
  });

  it("inline fetch error is a HARD block (#2620)", () => {
    expect(
      verdictBlockIsSoftOnly(verdict({ found: true, lastReviewedSha: HEAD, confidence: 5 }), HEAD, {
        p0Count: 0,
        p1Count: 0,
        unresolvedThreadCount: 0,
        error: "graphql reviewThreads failed",
      }),
    ).toBe(false);
  });
});
