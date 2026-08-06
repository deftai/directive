/**
 * Material-progress evaluation for delivery-attempt circuit breaker (#3143).
 *
 * Material progress = verifiable state change that can resolve or advance
 * beyond the current failure. New revision ids, worker swaps, compaction,
 * and analysis restatement alone are not material progress.
 */

import type { FailureInfo, MaterialDeltaClaim, MaterialDeltaKind } from "./types.js";

/** Kinds that can count as progress when they address the failing invariant. */
const PROGRESS_KINDS: ReadonlySet<MaterialDeltaKind> = new Set([
  "code",
  "configuration",
  "evidence",
  "external-state",
  "stage",
]);

export interface MaterialProgressResult {
  readonly isMaterial: boolean;
  readonly classification: MaterialDeltaKind | "none";
  readonly relevantClaims: readonly MaterialDeltaClaim[];
  readonly reason: string;
}

/**
 * Whether claimed deltas address the current failure (or advance stage).
 *
 * Source-bound evidence: claims whose sourceRevision does not match the
 * evaluated revision are ignored (cannot treat intermediate evidence as
 * valid for a later revision).
 */
export function evaluateMaterialProgress(options: {
  readonly claims: readonly MaterialDeltaClaim[] | null | undefined;
  readonly failure: FailureInfo | null | undefined;
  readonly evaluatedRevision: string;
  /**
   * When true (default), evidence/external claims must match evaluatedRevision.
   * Code/config/stage claims may apply if addresses match even when revision
   * changed (the new revision *is* the delta carrier).
   */
  readonly enforceSourceBoundEvidence?: boolean;
}): MaterialProgressResult {
  const claims = options.claims ?? [];
  const enforceBound = options.enforceSourceBoundEvidence !== false;
  const failure = options.failure ?? null;
  const rev = options.evaluatedRevision;

  if (claims.length === 0) {
    return {
      isMaterial: false,
      classification: "none",
      relevantClaims: [],
      reason: "no material delta claims",
    };
  }

  const relevant: MaterialDeltaClaim[] = [];
  for (const claim of claims) {
    if (claim.kind === "none" || claim.kind === "unrelated") {
      continue;
    }
    if (!PROGRESS_KINDS.has(claim.kind)) {
      continue;
    }
    // Source-bound evidence: intermediate revision evidence is invalid for later rev.
    if (
      enforceBound &&
      (claim.kind === "evidence" || claim.kind === "external-state") &&
      claim.sourceRevision !== rev
    ) {
      continue;
    }
    if (claimAddressesFailure(claim, failure)) {
      relevant.push(claim);
    }
  }

  if (relevant.length === 0) {
    const onlyUnrelated = claims.every((c) => c.kind === "unrelated" || c.kind === "none");
    return {
      isMaterial: false,
      classification: onlyUnrelated ? "unrelated" : "none",
      relevantClaims: [],
      reason: onlyUnrelated
        ? "revision churn / unrelated delta does not address failing invariant"
        : "claimed deltas do not address the failing invariant or are source-bound mismatched",
    };
  }

  // Prefer strongest classification for observability.
  const order: MaterialDeltaKind[] = [
    "stage",
    "code",
    "configuration",
    "evidence",
    "external-state",
  ];
  const first = relevant[0];
  let classification: MaterialDeltaKind = first !== undefined ? first.kind : "none";
  for (const k of order) {
    if (relevant.some((c) => c.kind === k)) {
      classification = k;
      break;
    }
  }

  return {
    isMaterial: true,
    classification,
    relevantClaims: relevant,
    reason: `relevant ${classification} delta addressing failure invariant`,
  };
}

function claimAddressesFailure(claim: MaterialDeltaClaim, failure: FailureInfo | null): boolean {
  // Stage advancement is always material progress when claimed.
  if (claim.kind === "stage") {
    return true;
  }
  // No prior failure → any progress-kind claim is material (first recovery path).
  if (failure === null) {
    return claim.addresses.length > 0 || PROGRESS_KINDS.has(claim.kind);
  }
  if (claim.addresses.length === 0) {
    // Empty addresses: only treat stage as auto-relevant (handled above).
    // Code/config without addresses is not trusted as material for a known failure.
    return false;
  }
  const targets = new Set(
    [failure.resourceClass ?? "", failure.stage, failure.code ?? "", failure.fingerprint]
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
  for (const a of claim.addresses) {
    const key = a.trim().toLowerCase();
    if (key.length === 0) continue;
    if (targets.has(key)) return true;
    // Prefix / substring match for component classes (e.g. "auth" matches "auth.permission").
    for (const t of targets) {
      if (t.includes(key) || key.includes(t)) return true;
    }
  }
  return false;
}

/**
 * Whether a new revision alone constitutes material progress.
 * Issue contract: creating a new revision identifier is NOT material progress.
 */
export function isRevisionChangeMaterial(
  _previousRevision: string | null,
  _nextRevision: string,
): boolean {
  return false;
}
