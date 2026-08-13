/**
 * Flag fail → method-change → pass on one product-oracle check id (#3322).
 *
 * A red verification may be resolved only by a product change (same method)
 * or an independently re-derived oracle (both sides rebuilt, different method).
 * In-place comparison repair then pass is unresolved.
 */

import { parseRunSummaryJsonl, type RunSummaryLine } from "../run-summary/index.js";
import type { VerificationOutcome } from "../run-summary/types.js";

export interface VerificationAttempt {
  readonly check_id: string;
  readonly method_fingerprint: string;
  readonly outcome: VerificationOutcome;
  readonly independent_rederivation: boolean;
  /** Session that emitted the attempt; used to avoid cross-session pairing. */
  readonly session_id: string;
}

export interface FlaggedMethodChangePass {
  readonly check_id: string;
  readonly failed_method: string;
  readonly passed_method: string;
  readonly independent_rederivation: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function isVerificationOutcome(value: unknown): value is VerificationOutcome {
  return value === "pass" || value === "fail";
}

function readAttempt(line: RunSummaryLine): VerificationAttempt | null {
  if (line.event !== "verification") {
    return null;
  }
  const payload = asRecord(line.payload);
  if (payload === null) {
    return null;
  }
  const checkId = payload.check_id;
  const fingerprint = payload.method_fingerprint;
  if (typeof checkId !== "string" || checkId.trim().length === 0) {
    return null;
  }
  if (typeof fingerprint !== "string" || fingerprint.trim().length === 0) {
    return null;
  }
  if (!isVerificationOutcome(payload.outcome)) {
    return null;
  }
  return {
    check_id: checkId,
    method_fingerprint: fingerprint,
    outcome: payload.outcome,
    independent_rederivation: payload.independent_rederivation === true,
    session_id: line.session_id,
  };
}

/** Extract well-formed verification attempts in stream order. */
export function readVerificationAttempts(lines: readonly RunSummaryLine[]): VerificationAttempt[] {
  const attempts: VerificationAttempt[] = [];
  for (const line of lines) {
    const attempt = readAttempt(line);
    if (attempt !== null) {
      attempts.push(attempt);
    }
  }
  return attempts;
}

/**
 * Flag each fail → different method → pass sequence on the same check id.
 * Independent re-derivation is recorded on the pass event, not inferred.
 */
export function flagPassAfterFailWithMethodChange(
  attempts: readonly VerificationAttempt[],
): FlaggedMethodChangePass[] {
  const lastFail = new Map<string, string>();
  const flagged: FlaggedMethodChangePass[] = [];
  for (const attempt of attempts) {
    const key = `${attempt.session_id}\0${attempt.check_id}`;
    if (attempt.outcome === "fail") {
      lastFail.set(key, attempt.method_fingerprint);
      continue;
    }
    const failedMethod = lastFail.get(key);
    if (failedMethod === undefined) {
      continue;
    }
    if (failedMethod === attempt.method_fingerprint) {
      lastFail.delete(key);
      continue;
    }
    flagged.push({
      check_id: attempt.check_id,
      failed_method: failedMethod,
      passed_method: attempt.method_fingerprint,
      independent_rederivation: attempt.independent_rederivation,
    });
    lastFail.delete(key);
  }
  return flagged;
}

/** Unresolved flags: method-change pass without recorded re-derivation. */
export function unresolvedMethodChangePasses(
  flagged: readonly FlaggedMethodChangePass[],
): FlaggedMethodChangePass[] {
  return flagged.filter((flag) => !flag.independent_rederivation);
}

/** Parse JSONL (or DEFT-TLM capture) and flag method-change passes. */
export function flagPassAfterFailFromJsonl(text: string): FlaggedMethodChangePass[] {
  return flagPassAfterFailWithMethodChange(readVerificationAttempts(parseRunSummaryJsonl(text)));
}
