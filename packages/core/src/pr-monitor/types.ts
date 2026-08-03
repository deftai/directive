import type { RunGhFn } from "../pr-merge-readiness/types.js";

export interface PollResult {
  readonly exitCode: number;
  readonly payload: Record<string, unknown>;
  readonly rawStdout: string;
  readonly rawStderr: string;
}

export interface MonotonicClock {
  now(): number;
}

export type SleepFn = (seconds: number) => void;

export type CallReadinessFn = (prNumber: number, repo: string) => PollResult;

export interface MonitorOptions {
  readonly capMinutes?: number;
  readonly cadence?: ReadonlyArray<readonly [number, number]>;
  readonly sleepFn?: SleepFn;
  readonly clockFn?: MonotonicClock;
  readonly callReadinessFn?: CallReadinessFn;
  readonly runGh?: RunGhFn;
  /**
   * Project root for plan.policy.review.minGreptileConfidence (#3095).
   * When pr-monitor targets a remote repo from a different cwd, pass the
   * monitored project's root so confidence policy is not resolved from cwd.
   */
  readonly projectRoot?: string | null;
}

export interface MonitorRunResult {
  readonly exitCode: number;
  readonly payload: Record<string, unknown>;
  readonly pollCount: number;
}

export interface CallReadinessOptions {
  readonly runGh?: RunGhFn;
  readonly timeoutMs?: number;
  /** Project root for minGreptileConfidence resolve (#3095). */
  readonly projectRoot?: string | null;
}
