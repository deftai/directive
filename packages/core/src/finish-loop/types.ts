/**
 * Walk-away finish-loop types (#871 Wave 5 / #2948).
 */

import type { AuthzDecisionCode } from "../authz/types.js";

/** Three-state + blocked exit codes for finish-loop surfaces. */
export const EXIT_OK = 0;
/** NEW_P0_P1 / address-needed / agent step required (non-terminal product halt). */
export const EXIT_ACTION_REQUIRED = 1;
/** BLOCKED (grant/gate), ERRORED, TIMEOUT, config. */
export const EXIT_BLOCKED = 2;

export type FinishLoopHaltReason =
  | "empty-queue"
  | "grant-missing"
  | "grant-expired"
  | "grant-deny"
  | "gate-deny"
  | "max-iterations"
  | "require-human-merge"
  | "address-findings"
  | "agent-implement"
  | "clean"
  | "merged"
  | "error";

export type FinishLoopPhase =
  | "gate"
  | "queue-scan"
  | "implement"
  | "pr-open"
  | "pr-watch"
  | "address"
  | "merge"
  | "halt";

export interface FinishLoopProgressLine {
  readonly schemaVersion: 1;
  readonly ts: string;
  readonly phase: FinishLoopPhase;
  readonly iteration: number;
  readonly haltReason: FinishLoopHaltReason | null;
  readonly message: string;
  readonly prNumber: number | null;
  readonly grantId: string | null;
  readonly queueCount: number | null;
  readonly exitCode: number | null;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface FinishLoopGrantGateResult {
  readonly allowed: boolean;
  readonly code: AuthzDecisionCode | "finish-loop-env-bypass" | "finish-loop-allow";
  readonly reason: string;
  readonly grantId: string | null;
  readonly missingOps: readonly string[];
}

export interface PrFinishLoopResult {
  readonly exitCode: number;
  readonly haltReason: FinishLoopHaltReason;
  readonly message: string;
  readonly prNumber: number;
  readonly watchVerdict: string | null;
  readonly mergeAttempted: boolean;
  readonly mergeSkippedReason: string | null;
  readonly grantId: string | null;
}

export interface DirectiveFinishLoopResult {
  readonly exitCode: number;
  readonly haltReason: FinishLoopHaltReason;
  readonly message: string;
  readonly iterations: number;
  readonly queueCount: number;
  readonly grantId: string | null;
  readonly progressPath: string;
}
