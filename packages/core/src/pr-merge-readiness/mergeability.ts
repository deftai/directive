import type { GreptileVerdict, RunGhFn } from "./types.js";

/**
 * GitHub's authoritative mergeability signal, read over REST (#2260).
 *
 * REST `mergeable_state` maps 1:1 to GraphQL `mergeStateStatus`
 * (e.g. `"clean"` == `CLEAN`); `mergeable` (boolean|null) maps to
 * `mergeable` (`MERGEABLE`/`CONFLICTING`/`UNKNOWN`). We read REST to honor
 * the "prefer REST over GraphQL" rule (#954) and to reuse the same
 * `gh api repos/<owner>/<repo>/pulls/<N>` surface fallback2 already uses.
 */
export interface MergeabilitySignal {
  readonly mergeableState: string | null;
  readonly mergeable: boolean | null;
  readonly error: string | null;
}

/** REST `mergeable_state` value that mirrors GraphQL `mergeStateStatus: CLEAN`. */
export const MERGE_STATE_CLEAN = "clean";

/**
 * Read GitHub's own mergeability verdict for a PR over REST.
 *
 * Injectable via `runGh` so unit tests stay hermetic (no live network).
 */
export function fetchMergeability(
  prNumber: number,
  repo: string,
  runGh: RunGhFn,
): MergeabilitySignal {
  const rc = runGh(["gh", "api", `repos/${repo}/pulls/${prNumber}`]);
  if (rc.returncode !== 0) {
    return {
      mergeableState: null,
      mergeable: null,
      error: `gh api /pulls/${prNumber} failed: ${rc.stderr.trim()}`,
    };
  }
  if (!rc.stdout.trim()) {
    return { mergeableState: null, mergeable: null, error: "empty body from gh api /pulls/<N>" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rc.stdout) as unknown;
  } catch (exc: unknown) {
    const message = exc instanceof Error ? exc.message : String(exc);
    return { mergeableState: null, mergeable: null, error: `could not parse PR JSON: ${message}` };
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      mergeableState: null,
      mergeable: null,
      error: "unexpected PR JSON shape (not a dict)",
    };
  }
  const pr = payload as Record<string, unknown>;
  const rawState = pr.mergeable_state;
  const rawMergeable = pr.mergeable;
  return {
    mergeableState: typeof rawState === "string" ? rawState : null,
    mergeable: typeof rawMergeable === "boolean" ? rawMergeable : null,
    error: null,
  };
}

/** True when GitHub itself reports the PR as CLEAN + MERGEABLE (#2260). */
export function isGithubMergeableClean(signal: MergeabilitySignal): boolean {
  return signal.mergeable === true && signal.mergeableState === MERGE_STATE_CLEAN;
}

/** Serialise the mergeability signal into the partial_data envelope shape. */
export function mergeabilityToDict(signal: MergeabilitySignal): Record<string, unknown> {
  return {
    mergeable_state: signal.mergeableState,
    mergeable: signal.mergeable,
    error: signal.error,
  };
}

/** True when a parsed verdict SHA does not match the current PR head SHA. */
export function verdictShaIsStale(verdict: GreptileVerdict, headSha: string | null): boolean {
  if (!verdict.found || verdict.lastReviewedSha === null || !headSha) {
    return false;
  }
  const reviewed = verdict.lastReviewedSha;
  return !(headSha.startsWith(reviewed) || reviewed.startsWith(headSha));
}

/**
 * Classify whether the verdict-based merge block is ONLY "soft" (#2260).
 *
 * A soft block means the review verdict is absent or pinned to a prior head
 * SHA (rebased staleness) -- i.e. the review has not spoken about the CURRENT
 * head. It is safe to reconcile a soft block against GitHub mergeability.
 *
 * A HARD block -- a genuine P0/P1 finding, an ERRORED review, or a low
 * confidence score on the current head -- is NEVER soft; those must keep
 * blocking regardless of GitHub mergeability (guardrail: do not merge a PR
 * with a real P0/P1 review finding).
 */
export function verdictBlockIsSoftOnly(verdict: GreptileVerdict, headSha: string | null): boolean {
  // Absent: no Greptile rolling-summary comment at all.
  if (!verdict.found) {
    return true;
  }
  // informal-clean (#1543) is a present-but-noncanonical verdict with its own
  // remediation path; it is out of scope for the #2260 mergeability override.
  if (verdict.informalClean) {
    return false;
  }
  // Stale: verdict pinned to a prior head SHA -> its findings pertain to old code.
  if (verdictShaIsStale(verdict, headSha)) {
    return true;
  }
  // Verdict is current (or its SHA is unparseable). A genuine current-head
  // finding is a hard block and must not be overridden.
  if (verdict.errored) {
    return false;
  }
  if (verdict.confidence !== null && verdict.confidence <= 3) {
    return false;
  }
  if (verdict.p0Count > 0 || verdict.p1Count > 0) {
    return false;
  }
  // No genuine finding: the block is a missing-canonical-field / not-yet-posted
  // wait, which GitHub mergeability may resolve.
  return true;
}
