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

export type ProbeFn = (prNumber: number, repo: string | null, runGh: RunGhFn) => WatchProbe;

export interface WatchOptions {
  readonly maxWaitMinutes?: number;
  readonly pollSeconds?: number;
  readonly oneShot?: boolean;
  readonly stallThreshold?: number;
  readonly runGh?: RunGhFn;
  readonly sleepFn?: SleepFn;
  readonly clockFn?: MonotonicClock;
  readonly probeFn?: ProbeFn;
}

export interface WatchResult {
  readonly verdict: string;
  readonly exitCode: number;
  readonly prNumber: number;
  readonly probe: WatchProbe;
  readonly elapsedSeconds: number;
  readonly pollCount: number;
}
