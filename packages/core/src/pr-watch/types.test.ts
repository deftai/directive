import { describe, expect, it } from "vitest";
import type { WatchProbe, WatchResult } from "./types.js";

/**
 * Type-only module: this test pins the WatchProbe / WatchResult shape at
 * compile time (a literal that omits or mistypes a field fails `tsc`) plus a
 * trivial runtime assertion so vitest has an executable case. It satisfies the
 * #1310 forward-coverage gate for the co-located type surface.
 */
describe("pr-watch types", () => {
  it("WatchProbe shape compiles and round-trips", () => {
    const probe: WatchProbe = {
      found: true,
      headSha: "abc",
      lastReviewedSha: "abc",
      shaMatch: true,
      confidence: 5,
      p0Count: 0,
      p1Count: 0,
      hasBlocking: false,
      errored: false,
      ciFailures: 0,
      terminalCheckRun: true,
      isClean: true,
      cleanGateHoldout: null,
      error: null,
    };
    expect(probe.isClean).toBe(true);
  });

  it("WatchResult embeds a probe plus loop bookkeeping", () => {
    const result: WatchResult = {
      verdict: "CLEAN",
      exitCode: 0,
      prNumber: 1056,
      probe: {
        found: true,
        headSha: "abc",
        lastReviewedSha: "abc",
        shaMatch: true,
        confidence: 5,
        p0Count: 0,
        p1Count: 0,
        hasBlocking: false,
        errored: false,
        ciFailures: 0,
        terminalCheckRun: true,
        isClean: true,
        cleanGateHoldout: null,
        error: null,
      },
      elapsedSeconds: 0,
      pollCount: 1,
    };
    expect(result.prNumber).toBe(1056);
    expect(result.probe.shaMatch).toBe(true);
  });
});
