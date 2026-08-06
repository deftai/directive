import type { RunGhFn } from "../pr-merge-readiness/types.js";

/** One resolved poll snapshot -- the parsed verdict + SHA-match gate for a PR. */
export interface WatchProbe {
  /** A Greptile/SLizard rolling-summary comment was present (non-empty body). */
  readonly found: boolean;
  readonly headSha: string | null;
  readonly lastReviewedSha: string | null;
  /** last_reviewed_sha === head_sha -- the SHA-match gate (#1056 stale-review guard). */
  readonly shaMatch: boolean;
  readonly confidence: number | null;
  readonly p0Count: number;
  readonly p1Count: number;
  readonly hasBlocking: boolean;
  readonly errored: boolean;
  readonly ciFailures: number;
  /** Failed required check identities (name + conclusion), when CI was probed. */
  readonly ciFailedChecks: readonly string[];
  /**
   * CI gate ready_state from evaluateCiGate (#2169 / #2672 / #3167).
   * Weather codes: `ci_never_scheduled`, `runner_capacity_stall`,
   * `ci_failures`, `ci_cancelled_no_failover` (plus `not_ready_yet` / `ready`).
   */
  readonly ciReadyState: string | null;
  /** Required checks classified as capacity-stalled (#2672). */
  readonly ciCapacityStalledChecks: readonly string[];
  /** All required CI check-runs have a terminal conclusion (none pending). */
  readonly terminalCheckRun: boolean;
  readonly isClean: boolean;
  /** First unmet clean-gate condition (evaluateCleanGate holdout), or null when clean. */
  readonly cleanGateHoldout: string | null;
  /** Non-null when the probe hit an external/config fault (unresolvable repo/HEAD, gh down). */
  readonly error: string | null;
}

export type SleepFn = (seconds: number) => void;

export interface MonotonicClock {
  now(): number;
}

export type ProbeFn = (
  prNumber: number,
  repo: string | null,
  runGh: RunGhFn,
  projectRoot?: string | null,
) => WatchProbe;

export interface WatchOptions {
  readonly maxWaitMinutes?: number;
  readonly pollSeconds?: number;
  readonly oneShot?: boolean;
  readonly stallThreshold?: number;
  readonly runGh?: RunGhFn;
  readonly sleepFn?: SleepFn;
  readonly clockFn?: MonotonicClock;
  readonly probeFn?: ProbeFn;
  /**
   * Project root for resolving plan.policy.review.minGreptileConfidence (#3095).
   * When omitted, probeOnce uses process.cwd(). Finish-loop / pr:watch MUST pass
   * the caller project-root so a chdir elsewhere cannot apply the wrong floor.
   */
  readonly projectRoot?: string | null;
}

export interface WatchResult {
  readonly verdict: string;
  readonly exitCode: number;
  readonly prNumber: number;
  readonly probe: WatchProbe;
  readonly elapsedSeconds: number;
  readonly pollCount: number;
}
