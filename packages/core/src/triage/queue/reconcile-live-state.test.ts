import { describe, expect, it } from "vitest";
import { type LiveOpenIssuesReader, reconcileLiveOpenState } from "./reconcile-live-state.js";
import type { CachedIssue } from "./types.js";

function issue(number: number, state: string): CachedIssue {
  return {
    number,
    title: `Issue ${number}`,
    state,
    labels: [],
    updatedAt: "",
    createdAt: "",
    metadataRank: null,
    continuation: false,
    continuationOrder: "",
    bucketDeficit: null,
    blocked: false,
  };
}

describe("reconcileLiveOpenState (#2238)", () => {
  // #2238 regression: a candidate whose cache still says `open` but is live-closed
  // must drop off the queue; a genuinely-open candidate must still render.
  it("drops a candidate that is live-closed but cached as open", () => {
    // Cache is stale: both look open, but #2115 is closed live.
    const candidates = [issue(2115, "open"), issue(3000, "open")];
    const stubReader: LiveOpenIssuesReader = () => new Set<number>([3000]);

    const reconciled = reconcileLiveOpenState(candidates, "owner/repo", stubReader);

    expect(reconciled.map((row) => row.number)).toEqual([3000]);
  });

  it("keeps all candidates when every one is live-open", () => {
    const candidates = [issue(1, "open"), issue(2, "open")];
    const stubReader: LiveOpenIssuesReader = () => new Set<number>([1, 2]);

    const reconciled = reconcileLiveOpenState(candidates, "owner/repo", stubReader);

    expect(reconciled.map((row) => row.number)).toEqual([1, 2]);
  });

  it("fails open (passes candidates through unchanged) when the reader returns null", () => {
    const candidates = [issue(1, "open"), issue(2115, "open")];
    const stubReader: LiveOpenIssuesReader = () => null;

    const reconciled = reconcileLiveOpenState(candidates, "owner/repo", stubReader);

    expect(reconciled).toBe(candidates);
  });

  it("preserves candidate ordering for the surviving open issues", () => {
    const candidates = [issue(10, "open"), issue(20, "open"), issue(30, "open")];
    const stubReader: LiveOpenIssuesReader = () => new Set<number>([30, 10]);

    const reconciled = reconcileLiveOpenState(candidates, "owner/repo", stubReader);

    expect(reconciled.map((row) => row.number)).toEqual([10, 30]);
  });
});
