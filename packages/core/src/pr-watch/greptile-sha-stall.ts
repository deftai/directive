/**
 * Sticky tip-rot sha_match → fail-loud greptile-sha-stall (#5162 Prefer-A Recut).
 *
 * Escalate only when clean_gate_holdout=sha_match, sticky summary names a
 * non-HEAD commit, and there is no in-flight Greptile Review on HEAD. Clock is
 * elapsed time since the first sticky observation (borrow ~10 min duration;
 * not Stall Rubric #564 IN_PROGRESS startedAt). Bare one-shot / one-poll
 * sha_match stays keep-wait (#2313).
 */

import { DEFAULT_STICKY_SHA_STALL_SECONDS, GREPTILE_SHA_STALL_REMEDY } from "./constants.js";
import type { WatchProbe } from "./types.js";

/** True when Greptile Review check-run status is still queued/in progress. */
export function isGreptileReviewInFlight(status: string | null | undefined): boolean {
  return status === "queued" || status === "in_progress" || status === "pending";
}

/**
 * Narrowed sticky tip-rot signature (#5162): sha_match holdout + sticky
 * non-HEAD Last-reviewed + no in-flight Greptile Review on HEAD.
 */
export function isStickyShaTipRot(probe: WatchProbe): boolean {
  if (probe.cleanGateHoldout !== "sha_match") {
    return false;
  }
  if (probe.headSha === null || probe.lastReviewedSha === null) {
    return false;
  }
  if (probe.lastReviewedSha === probe.headSha) {
    return false;
  }
  if (probe.greptileReviewInFlight === true) {
    return false;
  }
  return true;
}

export interface GreptileShaStallEvalInput {
  readonly probe: WatchProbe;
  /** Elapsed seconds since first sticky tip-rot observation on current HEAD. */
  readonly stickyElapsedSeconds: number;
  /** Prefer-A sticky-sha clock; defaults to DEFAULT_STICKY_SHA_STALL_SECONDS. */
  readonly stickyShaStallSeconds?: number;
  /** Bare one-shot / one-poll must not escalate (#2313 / Prefer-A). */
  readonly oneShot?: boolean;
}

/**
 * Returns `BLOCKED: greptile-sha-stall` when the narrowed signature + sticky-sha
 * clock fire; otherwise null (keep-wait / PENDING / not tip-rot).
 */
export function evaluateGreptileShaStallRemedy(input: GreptileShaStallEvalInput): string | null {
  if (input.oneShot === true) {
    return null;
  }
  if (!isStickyShaTipRot(input.probe)) {
    return null;
  }
  const clock = input.stickyShaStallSeconds ?? DEFAULT_STICKY_SHA_STALL_SECONDS;
  if (input.stickyElapsedSeconds < clock) {
    return null;
  }
  return GREPTILE_SHA_STALL_REMEDY;
}
