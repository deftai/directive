/**
 * Empty verify:ac resolution is not a green run when there is no suite floor (#3334).
 *
 * Framework source keeps today's floor-pass (suite gates own the floor).
 * Consumer / no-suite projects fail closed with a distinct soft_empty outcome.
 */

import { isFrameworkRepoRoot } from "../check/context.js";
import type { PlanAcceptance } from "./types.js";

export const EMPTY_AC_OUTCOME = "soft_empty" as const;
export const EMPTY_AC_CAUSE = "no acceptance stamped — floor is empty in this project";
export const EMPTY_AC_REMEDY =
  "stamp plan.acceptance via clause derivation (scope:activate / scope:promote runs #3323, or task issue:ingest)";

export const TRANSCRIPT_EMPTY_CAUSE = "transcript skip left zero captured commands";
export const TRANSCRIPT_EMPTY_REMEDY =
  "stamp real acceptance commands; suite-floor empty-pass does not apply when a transcript fence dropped prompt lines (#3511)";

export type VerifyAcResolution =
  | "verified-pass"
  | "empty-pass"
  | "soft_empty"
  | "fail"
  | "config"
  | "skipped"
  | "rejected-noop";

/** True when this project check composition includes a suite gate (#3188). */
export function projectHasSuiteFloor(projectRoot: string): boolean {
  return isFrameworkRepoRoot(projectRoot);
}

export function isSoftEmptyAcText(text: string): boolean {
  return /soft_empty\s*\(#3334\)/i.test(text);
}

export interface EmptyAcResolutionInput {
  readonly ok: boolean;
  readonly code: number;
  readonly runsLength: number;
  readonly commandCount: number;
  readonly rejectedCount: number;
  readonly resolution?: VerifyAcResolution;
}

/** Zero executable commands, no rejected/unpromoted ledger, not already classified. */
export function isEmptyAcResolution(input: EmptyAcResolutionInput): boolean {
  if (
    input.resolution === "config" ||
    input.resolution === "skipped" ||
    input.resolution === "rejected-noop"
  ) {
    return false;
  }
  if (input.code === 2) {
    return false;
  }
  if (input.rejectedCount > 0 || input.commandCount > 0 || input.runsLength > 0) {
    return false;
  }
  return true;
}

export function formatSoftEmptyMessage(acceptance: PlanAcceptance, quiet?: boolean): string {
  if (quiet) {
    return "";
  }
  return (
    `verify:ac ${EMPTY_AC_OUTCOME} (#3334) [rung=${acceptance.source_rung}]: ` +
    `${EMPTY_AC_CAUSE}. ${EMPTY_AC_REMEDY}.`
  );
}

export function formatTranscriptEmptyMessage(acceptance: PlanAcceptance, quiet?: boolean): string {
  if (quiet) {
    return "";
  }
  return (
    `verify:ac FAILED (#3511) [rung=${acceptance.source_rung}]: ` +
    `${TRANSCRIPT_EMPTY_CAUSE}. ${TRANSCRIPT_EMPTY_REMEDY}.`
  );
}
