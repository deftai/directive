import { describe, expect, it, vi } from "vitest";
import {
  EXIT_CLEAN,
  EXIT_NEW_P0_P1,
  EXIT_TERMINAL_ERROR,
  VERDICT_CI_BLOCKED,
  VERDICT_CI_CANCELLED_NO_FAILOVER,
  VERDICT_CI_NEVER_SCHEDULED,
  VERDICT_CLEAN,
  VERDICT_CONFIG,
  VERDICT_ERRORED,
  VERDICT_NEW_P0_P1,
  VERDICT_PENDING,
  VERDICT_RUNNER_CAPACITY_STALL,
  VERDICT_STALL,
  VERDICT_TIMEOUT,
} from "./constants.js";
import type { MonotonicClock, SleepFn, WatchProbe } from "./types.js";
import { formatWatchStatus, watch } from "./watch.js";

const HEAD = "abcdef1234567890abcdef1234567890abcdef12";
const STALE = "0000000000000000000000000000000000000000";

function makeProbe(overrides: Partial<WatchProbe> = {}): WatchProbe {
  return {
    found: true,
    headSha: HEAD,
    lastReviewedSha: HEAD,
    shaMatch: true,
    confidence: 5,
    p0Count: 0,
    p1Count: 0,
    hasBlocking: false,
    errored: false,
    ciFailures: 0,
    ciFailedChecks: [],
    ciReadyState: "ready",
    ciCapacityStalledChecks: [],
    terminalCheckRun: true,
    isClean: false,
    cleanGateHoldout: null,
    error: null,
    ...overrides,
  };
}

/** Fake clock that only advances when the injected sleep is invoked. */
class FakeClock implements MonotonicClock {
  value = 0;
  now(): number {
    return this.value;
  }
}

function makeSleep(clock: FakeClock): SleepFn {
  return (seconds: number) => {
    clock.value += seconds;
  };
}

/** Injected probeFn that replays a fixed sequence of probes (last repeats). */
function makeProbeSeq(...probes: WatchProbe[]) {
  const seq = [...probes];
  const calls: number[] = [];
  const fn = (prNumber: number): WatchProbe => {
    calls.push(prNumber);
    return seq.length > 1 ? (seq.shift() as WatchProbe) : (seq[0] as WatchProbe);
  };
  return { fn, calls };
}

describe("watch verdict matrix (one-shot, single probe)", () => {
  const runOneShot = (probe: WatchProbe) => {
    const { fn } = makeProbeSeq(probe);
    return watch(42, "deftai/directive", { oneShot: true, probeFn: fn });
  };

  it("CLEAN -> exit 0", () => {
    const r = runOneShot(makeProbe({ isClean: true, cleanGateHoldout: null }));
    expect(r.verdict).toBe(VERDICT_CLEAN);
    expect(r.exitCode).toBe(EXIT_CLEAN);
  });

  it("NEW_P0_P1 (P0, sha-matched) -> exit 1", () => {
    const r = runOneShot(
      makeProbe({
        hasBlocking: true,
        p0Count: 1,
        shaMatch: true,
        cleanGateHoldout: "has_blocking",
      }),
    );
    expect(r.verdict).toBe(VERDICT_NEW_P0_P1);
    expect(r.exitCode).toBe(EXIT_NEW_P0_P1);
  });

  it("NEW_P0_P1 (P1, sha-matched) -> exit 1", () => {
    const r = runOneShot(
      makeProbe({
        hasBlocking: true,
        p1Count: 2,
        shaMatch: true,
        cleanGateHoldout: "has_blocking",
      }),
    );
    expect(r.verdict).toBe(VERDICT_NEW_P0_P1);
    expect(r.exitCode).toBe(EXIT_NEW_P0_P1);
  });

  it("blocking findings on a STALE sha are NOT read as NEW_P0_P1 (SHA-match gate)", () => {
    const r = runOneShot(
      makeProbe({
        hasBlocking: true,
        p1Count: 1,
        lastReviewedSha: STALE,
        shaMatch: false,
        cleanGateHoldout: "sha_match",
      }),
    );
    // Review present but stuck on a stale commit, single probe -> PENDING, not NEW_P0_P1.
    expect(r.verdict).toBe(VERDICT_PENDING);
    expect(r.exitCode).toBe(EXIT_TERMINAL_ERROR);
  });

  it("ERRORED sentinel -> exit 2", () => {
    const r = runOneShot(makeProbe({ errored: true, shaMatch: true, cleanGateHoldout: "errored" }));
    expect(r.verdict).toBe(VERDICT_ERRORED);
    expect(r.exitCode).toBe(EXIT_TERMINAL_ERROR);
  });

  it("CONFIG error probe -> exit 2", () => {
    const r = runOneShot(makeProbe({ error: "could not resolve repo", headSha: null }));
    expect(r.verdict).toBe(VERDICT_CONFIG);
    expect(r.exitCode).toBe(EXIT_TERMINAL_ERROR);
  });

  it("no-terminal single probe -> PENDING exit 2", () => {
    const r = runOneShot(
      makeProbe({ found: false, lastReviewedSha: null, shaMatch: false, confidence: null }),
    );
    expect(r.verdict).toBe(VERDICT_PENDING);
    expect(r.exitCode).toBe(EXIT_TERMINAL_ERROR);
    expect(r.pollCount).toBe(1);
  });

  it("ci_failures holdout on one-shot -> CI_BLOCKED exit 2 (#2688)", () => {
    const r = runOneShot(
      makeProbe({
        isClean: false,
        cleanGateHoldout: "ci_failures",
        ciFailures: 1,
        ciFailedChecks: ["CodeQL (failure)"],
        confidence: 5,
        shaMatch: true,
      }),
    );
    expect(r.verdict).toBe(VERDICT_CI_BLOCKED);
    expect(r.exitCode).toBe(EXIT_TERMINAL_ERROR);
    expect(r.probe.ciFailedChecks).toEqual(["CodeQL (failure)"]);
  });

  it("runner_capacity_stall -> RUNNER_CAPACITY_STALL exit 2 (#2672)", () => {
    const r = runOneShot(
      makeProbe({
        isClean: false,
        cleanGateHoldout: "ci_failures",
        ciReadyState: "runner_capacity_stall",
        ciCapacityStalledChecks: ["TypeScript (build + lint + test)"],
        terminalCheckRun: false,
        confidence: 5,
        shaMatch: true,
      }),
    );
    expect(r.verdict).toBe(VERDICT_RUNNER_CAPACITY_STALL);
    expect(r.exitCode).toBe(EXIT_TERMINAL_ERROR);
    expect(r.probe.ciCapacityStalledChecks).toEqual(["TypeScript (build + lint + test)"]);
  });

  it("ci_never_scheduled -> CI_NEVER_SCHEDULED exit 2 (#3167)", () => {
    const r = runOneShot(
      makeProbe({
        isClean: false,
        cleanGateHoldout: "ci_never_scheduled",
        ciReadyState: "ci_never_scheduled",
        terminalCheckRun: true,
        confidence: 5,
        shaMatch: true,
      }),
    );
    expect(r.verdict).toBe(VERDICT_CI_NEVER_SCHEDULED);
    expect(r.exitCode).toBe(EXIT_TERMINAL_ERROR);
  });

  it("ci_cancelled_no_failover -> CI_CANCELLED_NO_FAILOVER exit 2 (#3167)", () => {
    const r = runOneShot(
      makeProbe({
        isClean: false,
        cleanGateHoldout: "ci_cancelled_no_failover",
        ciReadyState: "ci_cancelled_no_failover",
        ciFailedChecks: ["TypeScript (blacksmith primary) (cancelled)"],
        ciFailures: 1,
        confidence: 5,
        shaMatch: true,
      }),
    );
    expect(r.verdict).toBe(VERDICT_CI_CANCELLED_NO_FAILOVER);
    expect(r.exitCode).toBe(EXIT_TERMINAL_ERROR);
  });

  it("ci_ready_state=ci_failures -> CI_BLOCKED exit 2 (#3167)", () => {
    const r = runOneShot(
      makeProbe({
        isClean: false,
        cleanGateHoldout: "ci_failures",
        ciReadyState: "ci_failures",
        ciFailures: 1,
        ciFailedChecks: ["TypeScript (build + lint + test) (failure)"],
        confidence: 5,
        shaMatch: true,
      }),
    );
    expect(r.verdict).toBe(VERDICT_CI_BLOCKED);
    expect(r.exitCode).toBe(EXIT_TERMINAL_ERROR);
  });
});

describe("watch blocking loop (injected clock + sleep)", () => {
  it("polls until CLEAN, advancing the clock via injected sleep", () => {
    const clock = new FakeClock();
    const sleep = vi.fn(makeSleep(clock));
    const pending = makeProbe({ isClean: false, cleanGateHoldout: "confidence", confidence: 2 });
    const clean = makeProbe({ isClean: true, cleanGateHoldout: null });
    const { fn, calls } = makeProbeSeq(pending, pending, clean);

    const r = watch(7, "deftai/directive", {
      pollSeconds: 90,
      maxWaitMinutes: 30,
      probeFn: fn,
      clockFn: clock,
      sleepFn: sleep,
    });

    expect(r.verdict).toBe(VERDICT_CLEAN);
    expect(r.exitCode).toBe(EXIT_CLEAN);
    expect(r.pollCount).toBe(3);
    expect(calls).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(90);
    expect(r.elapsedSeconds).toBe(180);
  });

  it("CI_BLOCKED after consecutive ci_failures holdouts (#2688)", () => {
    const clock = new FakeClock();
    const sleep = vi.fn(makeSleep(clock));
    const ciRed = makeProbe({
      isClean: false,
      cleanGateHoldout: "ci_failures",
      ciFailures: 2,
      ciFailedChecks: ["build (failure)", "CodeQL (failure)"],
      confidence: 5,
      shaMatch: true,
    });
    const { fn } = makeProbeSeq(ciRed);

    const r = watch(8, "deftai/directive", {
      pollSeconds: 30,
      maxWaitMinutes: 30,
      probeFn: fn,
      clockFn: clock,
      sleepFn: sleep,
    });

    expect(r.verdict).toBe(VERDICT_CI_BLOCKED);
    expect(r.exitCode).toBe(EXIT_TERMINAL_ERROR);
    expect(r.pollCount).toBe(3);
  });

  it("does NOT STALL on stale-SHA confidence during re-review (#2313)", () => {
    const clock = new FakeClock();
    const sleep = vi.fn(makeSleep(clock));
    const staleReReview = makeProbe({
      lastReviewedSha: STALE,
      shaMatch: false,
      hasBlocking: false,
      isClean: false,
      cleanGateHoldout: "sha_match",
      confidence: 4,
    });
    const { fn } = makeProbeSeq(staleReReview);

    const r = watch(9, "deftai/directive", {
      pollSeconds: 1,
      maxWaitMinutes: 0.1,
      stallThreshold: 3,
      probeFn: fn,
      clockFn: clock,
      sleepFn: sleep,
    });

    expect(r.verdict).toBe(VERDICT_TIMEOUT);
    expect(r.exitCode).toBe(EXIT_TERMINAL_ERROR);
    expect(r.pollCount).toBeGreaterThan(3);
  });

  it("STALL after stallThreshold wedged HEAD holdouts (#1039)", () => {
    const clock = new FakeClock();
    const sleep = vi.fn(makeSleep(clock));
    const wedged = makeProbe({
      shaMatch: true,
      hasBlocking: false,
      isClean: false,
      cleanGateHoldout: "terminal_check_run",
      confidence: 5,
      terminalCheckRun: false,
    });
    const { fn } = makeProbeSeq(wedged);

    const r = watch(9, "deftai/directive", {
      pollSeconds: 30,
      maxWaitMinutes: 30,
      stallThreshold: 3,
      probeFn: fn,
      clockFn: clock,
      sleepFn: sleep,
    });

    expect(r.verdict).toBe(VERDICT_STALL);
    expect(r.exitCode).toBe(EXIT_TERMINAL_ERROR);
    expect(r.pollCount).toBe(3);
  });

  it("TIMEOUT when the review never appears before the cap", () => {
    const clock = new FakeClock();
    const sleep = vi.fn(makeSleep(clock));
    const nothing = makeProbe({
      found: false,
      lastReviewedSha: null,
      shaMatch: false,
      confidence: null,
      isClean: false,
      cleanGateHoldout: "sha_match",
    });
    const { fn } = makeProbeSeq(nothing);

    const r = watch(11, "deftai/directive", {
      pollSeconds: 1,
      // 3s cap: poll1(elapsed0)->sleep, poll2(elapsed1)->sleep, poll3(elapsed2)+1>=3 -> TIMEOUT.
      maxWaitMinutes: 0.05,
      probeFn: fn,
      clockFn: clock,
      sleepFn: sleep,
    });

    expect(r.verdict).toBe(VERDICT_TIMEOUT);
    expect(r.exitCode).toBe(EXIT_TERMINAL_ERROR);
  });

  it("does NOT sleep on --one-shot", () => {
    const sleep = vi.fn();
    const { fn } = makeProbeSeq(makeProbe({ isClean: false, cleanGateHoldout: "confidence" }));
    const r = watch(3, "deftai/directive", { oneShot: true, probeFn: fn, sleepFn: sleep });
    expect(r.verdict).toBe(VERDICT_PENDING);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("formatWatchStatus", () => {
  it("renders the per-poll instrumentation line", () => {
    const line = formatWatchStatus(2, 21, makeProbe({ p1Count: 1, hasBlocking: true }), 90);
    expect(line).toContain("poll 2/21");
    expect(line).toContain("head=abcdef123456");
    expect(line).toContain("sha_match=true");
    expect(line).toContain("p1=1");
    expect(line).toContain("elapsed=90s");
  });

  it("renders a CONFIG-ERROR line when the probe errored", () => {
    const line = formatWatchStatus(1, 1, makeProbe({ error: "gh CLI not found" }), 0);
    expect(line).toContain("CONFIG-ERROR");
    expect(line).toContain("gh CLI not found");
  });
});
