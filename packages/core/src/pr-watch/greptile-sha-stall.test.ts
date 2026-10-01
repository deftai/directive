import { describe, expect, it } from "vitest";
import { DEFAULT_STICKY_SHA_STALL_SECONDS, GREPTILE_SHA_STALL_REMEDY } from "./constants.js";
import {
  evaluateGreptileShaStallRemedy,
  isGreptileReviewInFlight,
  isStickyShaTipRot,
} from "./greptile-sha-stall.js";
import type { WatchProbe } from "./types.js";

const HEAD = "abcdef1234567890abcdef1234567890abcdef12";
const STALE = "0000000000000000000000000000000000000000";

function makeProbe(overrides: Partial<WatchProbe> = {}): WatchProbe {
  return {
    found: true,
    headSha: HEAD,
    lastReviewedSha: STALE,
    shaMatch: false,
    confidence: 4,
    p0Count: 0,
    p1Count: 0,
    hasBlocking: false,
    errored: false,
    ciFailures: 0,
    ciFailedChecks: [],
    ciReadyState: "ready",
    ciCapacityStalledChecks: [],
    terminalCheckRun: true,
    greptileReviewInFlight: false,
    isClean: false,
    cleanGateHoldout: "sha_match",
    reviewerReadyState: "expected",
    reviewCycleHandback: null,
    prState: "open",
    prMerged: false,
    error: null,
    ...overrides,
  };
}

describe("greptile-sha-stall Prefer-A Recut (#5162)", () => {
  it("detects in-flight Greptile Review statuses", () => {
    expect(isGreptileReviewInFlight("queued")).toBe(true);
    expect(isGreptileReviewInFlight("in_progress")).toBe(true);
    expect(isGreptileReviewInFlight("pending")).toBe(true);
    expect(isGreptileReviewInFlight("completed")).toBe(false);
    expect(isGreptileReviewInFlight(undefined)).toBe(false);
  });

  it("routes narrowed sticky tip-rot sha_match to BLOCKED: greptile-sha-stall", () => {
    const probe = makeProbe();
    expect(isStickyShaTipRot(probe)).toBe(true);
    expect(
      evaluateGreptileShaStallRemedy({
        probe,
        stickyElapsedSeconds: DEFAULT_STICKY_SHA_STALL_SECONDS,
      }),
    ).toBe(GREPTILE_SHA_STALL_REMEDY);
    expect(GREPTILE_SHA_STALL_REMEDY).toBe("BLOCKED: greptile-sha-stall");
  });

  it("does not escalate bare one-shot / one-poll sha_match", () => {
    expect(
      evaluateGreptileShaStallRemedy({
        probe: makeProbe(),
        stickyElapsedSeconds: DEFAULT_STICKY_SHA_STALL_SECONDS,
        oneShot: true,
      }),
    ).toBeNull();
  });

  it("treats unknown inventory (greptileReviewInFlight default) as non-escalating tip-rot", () => {
    // Probe construction leaves greptileReviewInFlight=false only when inventory is known idle.
    // Unknown inventory must set greptileReviewInFlight=true in probeOnce; sticky tip-rot then false.
    const probe = makeProbe({ greptileReviewInFlight: true, cleanGateHoldout: "sha_match" });
    expect(isStickyShaTipRot(probe)).toBe(false);
  });

  it("does not escalate while Greptile Review is in flight on HEAD", () => {
    const probe = makeProbe({ greptileReviewInFlight: true });
    expect(isStickyShaTipRot(probe)).toBe(false);
    expect(
      evaluateGreptileShaStallRemedy({
        probe,
        stickyElapsedSeconds: DEFAULT_STICKY_SHA_STALL_SECONDS,
      }),
    ).toBeNull();
  });

  it("does not escalate before the sticky-sha clock", () => {
    expect(
      evaluateGreptileShaStallRemedy({
        probe: makeProbe(),
        stickyElapsedSeconds: DEFAULT_STICKY_SHA_STALL_SECONDS - 1,
      }),
    ).toBeNull();
  });

  it("does not treat sha_match tip-rot as CLEAN or dest-residual", () => {
    const remedy = evaluateGreptileShaStallRemedy({
      probe: makeProbe(),
      stickyElapsedSeconds: DEFAULT_STICKY_SHA_STALL_SECONDS,
    });
    expect(remedy).toBe(GREPTILE_SHA_STALL_REMEDY);
    expect(remedy).not.toBe("CLEAN");
    expect(remedy).not.toMatch(/dest.?residual/i);
  });
});
