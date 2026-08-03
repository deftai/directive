import { defaultRunGh } from "../pr-merge-readiness/gh.js";
import {
  DEFAULT_CI_BLOCKED_THRESHOLD,
  DEFAULT_MAX_WAIT_MINUTES,
  DEFAULT_POLL_SECONDS,
  DEFAULT_STALL_THRESHOLD,
  EXIT_CLEAN,
  EXIT_NEW_P0_P1,
  EXIT_TERMINAL_ERROR,
  VERDICT_CI_BLOCKED,
  VERDICT_CLEAN,
  VERDICT_CONFIG,
  VERDICT_ERRORED,
  VERDICT_NEW_P0_P1,
  VERDICT_PENDING,
  VERDICT_RUNNER_CAPACITY_STALL,
  VERDICT_STALL,
  VERDICT_TIMEOUT,
} from "./constants.js";
import { probeOnce } from "./probe.js";
import type { MonotonicClock, WatchOptions, WatchProbe, WatchResult } from "./types.js";

const systemMonotonicClock: MonotonicClock = {
  now(): number {
    return performance.now() / 1000;
  },
};

/** Synchronous, non-CPU-spinning sleep (Atomics.wait); injectable in tests. */
function defaultSleep(seconds: number): void {
  const ms = Math.max(0, Math.trunc(seconds * 1000));
  if (ms === 0) {
    return;
  }
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

function shortSha(sha: string | null): string {
  return sha === null ? "<none>" : sha.slice(0, 12);
}

/** One-line stderr status mirror per poll (Tier 1 instrumentation shape, #1039). */
export function formatWatchStatus(
  poll: number,
  maxPolls: number,
  probe: WatchProbe,
  elapsedSeconds: number,
): string {
  if (probe.error !== null) {
    return `[pr:watch poll ${poll}/${maxPolls}] CONFIG-ERROR elapsed=${elapsedSeconds}s -- ${probe.error}`;
  }
  return (
    `[pr:watch poll ${poll}/${maxPolls}] head=${shortSha(probe.headSha)} ` +
    `last_reviewed=${shortSha(probe.lastReviewedSha)} sha_match=${probe.shaMatch} ` +
    `confidence=${probe.confidence} p0=${probe.p0Count} p1=${probe.p1Count} ` +
    `errored=${probe.errored} ci_failures=${probe.ciFailures} is_clean=${probe.isClean} ` +
    `clean_gate_holdout=${probe.cleanGateHoldout} elapsed=${elapsedSeconds}s`
  );
}

/**
 * Blocking-by-default poll to a terminal three-state verdict (#1056). Default
 * behaviour is a synchronous wait, so a linear caller (human shell, CI step,
 * single-process agent) gets the verdict for free; --one-shot degrades to a
 * single probe. SHA-match gating means a stale review posted BEFORE your push
 * is never read as the verdict.
 */
export function watch(
  prNumber: number,
  repo: string | null,
  options: WatchOptions = {},
): WatchResult {
  const maxWaitMinutes = options.maxWaitMinutes ?? DEFAULT_MAX_WAIT_MINUTES;
  const pollSeconds = Math.max(1, options.pollSeconds ?? DEFAULT_POLL_SECONDS);
  const oneShot = options.oneShot ?? false;
  const stallThreshold = options.stallThreshold ?? DEFAULT_STALL_THRESHOLD;
  const runGh = options.runGh ?? defaultRunGh;
  const clockFn = options.clockFn ?? systemMonotonicClock;
  const sleepFn = options.sleepFn ?? defaultSleep;
  const projectRoot = options.projectRoot ?? null;
  const probeFn = options.probeFn ?? ((n, r, gh, root) => probeOnce(n, r, gh, root ?? projectRoot));

  const capSeconds = Math.max(0, maxWaitMinutes * 60);
  // Bounded loop (time is still the authority via the cap check below) so no
  // unbounded `while (true)`; +1 covers the trailing poll after the final wait.
  const maxPolls = oneShot ? 1 : Math.max(1, Math.ceil(capSeconds / pollSeconds) + 1);
  const startedAt = clockFn.now();

  let lastProbe: WatchProbe | null = null;
  let stallStreak = 0;
  let ciBlockedStreak = 0;

  const build = (
    verdict: string,
    exitCode: number,
    probe: WatchProbe,
    poll: number,
  ): WatchResult => ({
    verdict,
    exitCode,
    prNumber,
    probe,
    elapsedSeconds: Math.round(clockFn.now() - startedAt),
    pollCount: poll,
  });

  for (let poll = 1; poll <= maxPolls; poll += 1) {
    const probe = probeFn(prNumber, repo, runGh, projectRoot);
    lastProbe = probe;
    const elapsed = Math.round(clockFn.now() - startedAt);
    process.stderr.write(`${formatWatchStatus(poll, maxPolls, probe, elapsed)}\n`);

    if (probe.error !== null) {
      return build(VERDICT_CONFIG, EXIT_TERMINAL_ERROR, probe, poll);
    }
    if (probe.isClean) {
      return build(VERDICT_CLEAN, EXIT_CLEAN, probe, poll);
    }
    // SHA-match gate: blocking findings only count as a verdict when the review
    // is on the CURRENT HEAD -- a stale pre-push review is not read as NEW_P0_P1.
    if (probe.hasBlocking && probe.shaMatch) {
      return build(VERDICT_NEW_P0_P1, EXIT_NEW_P0_P1, probe, poll);
    }
    if (probe.errored) {
      return build(VERDICT_ERRORED, EXIT_TERMINAL_ERROR, probe, poll);
    }

    // #2672: capacity stall is distinct from ordinary not_ready_yet — surface
    // immediately (exit 2) so agents wait for auto-failover instead of --skip-ci.
    if (probe.ciReadyState === "runner_capacity_stall") {
      return build(VERDICT_RUNNER_CAPACITY_STALL, EXIT_TERMINAL_ERROR, probe, poll);
    }

    // #2688: Greptile side satisfied on HEAD but CI red — fail loud toward a
    // fix loop instead of burning max-wait-minutes on idle Greptile polls.
    if (probe.cleanGateHoldout === "ci_failures") {
      ciBlockedStreak += 1;
    } else {
      ciBlockedStreak = 0;
    }
    if (oneShot && probe.cleanGateHoldout === "ci_failures") {
      return build(VERDICT_CI_BLOCKED, EXIT_TERMINAL_ERROR, probe, poll);
    }
    if (!oneShot && ciBlockedStreak >= DEFAULT_CI_BLOCKED_THRESHOLD) {
      return build(VERDICT_CI_BLOCKED, EXIT_TERMINAL_ERROR, probe, poll);
    }

    // STALL (#1039): wedged CLEAN-gate on HEAD — !has_blocking && !is_clean for N
    // consecutive polls with a holdout OTHER than sha_match. Stale-SHA reads
    // (clean_gate_holdout=sha_match) are INCOMPLETE for HEAD per #1259 / #2313 —
    // keep polling until cap, not early STALL while re-review is in flight.
    if (!probe.hasBlocking && !probe.isClean && probe.cleanGateHoldout !== "sha_match") {
      stallStreak += 1;
    } else {
      stallStreak = 0;
    }
    if (stallStreak >= stallThreshold) {
      return build(VERDICT_STALL, EXIT_TERMINAL_ERROR, probe, poll);
    }

    if (oneShot) {
      return build(VERDICT_PENDING, EXIT_TERMINAL_ERROR, probe, poll);
    }

    const elapsedNow = clockFn.now() - startedAt;
    if (poll >= maxPolls || elapsedNow + pollSeconds >= capSeconds) {
      return build(VERDICT_TIMEOUT, EXIT_TERMINAL_ERROR, probe, poll);
    }
    sleepFn(pollSeconds);
  }

  // Unreachable in practice (the in-loop cap check returns TIMEOUT first); kept
  // as a total-function fallback so the return type is honoured.
  const probe = lastProbe ?? {
    found: false,
    headSha: null,
    lastReviewedSha: null,
    shaMatch: false,
    confidence: null,
    p0Count: 0,
    p1Count: 0,
    hasBlocking: false,
    errored: false,
    ciFailures: 0,
    ciFailedChecks: [],
    ciReadyState: null,
    ciCapacityStalledChecks: [],
    terminalCheckRun: false,
    isClean: false,
    cleanGateHoldout: null,
    error: null,
  };
  return build(VERDICT_TIMEOUT, EXIT_TERMINAL_ERROR, probe, maxPolls);
}
