/**
 * Deterministic handoff-evidence validator (#3120).
 *
 * status pass is forbidden when any remote artifact is claimed unless
 * proof_status is bound and same-turn probe snippets cover each claim.
 * Invented-done (false remote artifacts under pass) ranks stricter than
 * empty-done (pass with no completion substance).
 */

/** Binding state for remote artifact claims in handoff evidence. */
export type ProofStatus = "bound" | "unbound" | "n/a-no-remote-claim";

/** Work / ship / gate axis state (local → forge → gates). */
export type AxisState = "done" | "in_progress" | "not_started" | "blocked" | "n/a";

/** Fail ranking: invented-done is stricter than empty-done. */
export type HandoffFailClass =
  | "none"
  | "empty-done"
  | "unbound-remote-claim"
  | "invented-done"
  | "shape-error";

/** Same-turn live probe that binds a remote claim. */
export interface RemoteProbe {
  /** Command run this turn (e.g. `gh api repos/.../pulls/N`). */
  readonly command: string;
  /** Short raw snippet from that command's stdout (not narration). */
  readonly snippet: string;
}

export interface AxisEvidence {
  readonly state?: AxisState | string;
  readonly notes?: string;
}

/**
 * Portable handoff evidence block for builder / pre-pr / review-cycle exits.
 * Free-text remote fields without bound probes are an illegal shape under pass.
 */
export interface HandoffEvidence {
  /** Overall process status. `pass` is the strictest gate for remote claims. */
  readonly status: "pass" | "fail" | "blocked" | "partial" | string;
  /**
   * Binding state. Required semantics:
   * - `bound` when any remote claim is present and probes bind them
   * - `n/a-no-remote-claim` when no remote PR/SHA/CI/review claim is made
   * - `unbound` is never valid under status pass with remote claims
   */
  readonly proof_status?: ProofStatus | string;
  /** Local work state (edits / tests / commits on the branch). */
  readonly work?: AxisEvidence;
  /** Ship state (pushed branch / PR exists). */
  readonly ship?: AxisEvidence;
  /** Gate state (CI / review on claimed HEAD). */
  readonly gate?: AxisEvidence;
  /** Remote PR URL claim (requires pr probe when set). */
  readonly pr_url?: string | null;
  /** Remote PR number claim (requires pr probe when set). */
  readonly pr_number?: number | string | null;
  /** Commit / HEAD SHA claim (requires sha probe when set). */
  readonly commit_sha?: string | null;
  /** Alias for commit_sha. */
  readonly head_sha?: string | null;
  /**
   * CI claim. Values like green/pass/success/ok are remote claims.
   * Neutral/unknown/pending without green semantics are not treated as claims.
   */
  readonly ci_status?: string | null;
  /** Review score / confidence claim (requires review probe when set). */
  readonly review_score?: number | string | null;
  /** Same-turn probes that bind remote claims. */
  readonly probes?: {
    readonly pr?: RemoteProbe | null;
    readonly sha?: RemoteProbe | null;
    readonly ci?: RemoteProbe | null;
    readonly review?: RemoteProbe | null;
  };
}

export interface HandoffEvidenceValidation {
  readonly ok: boolean;
  readonly failClass: HandoffFailClass;
  readonly reasons: readonly string[];
  /** True when any remote PR/SHA/CI/review claim was detected. */
  readonly hasRemoteClaims: boolean;
  /** Claim keys that lack a binding probe. */
  readonly unboundClaims: readonly string[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPresentClaim(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  return true;
}

function probeBinds(probe: RemoteProbe | null | undefined): boolean {
  if (!probe) return false;
  return isNonEmptyString(probe.command) && isNonEmptyString(probe.snippet);
}

/** Detect which remote claim keys are present on the evidence object. */
export function detectRemoteClaims(evidence: HandoffEvidence): string[] {
  const claims: string[] = [];
  if (isPresentClaim(evidence.pr_url)) claims.push("pr_url");
  if (isPresentClaim(evidence.pr_number)) claims.push("pr_number");
  if (isPresentClaim(evidence.commit_sha)) claims.push("commit_sha");
  if (isPresentClaim(evidence.head_sha)) claims.push("head_sha");
  if (isPresentClaim(evidence.ci_status)) {
    const ci = String(evidence.ci_status).trim();
    // Neutral tokens are not remote claims; green-family and other explicit
    // forge outcomes (failing, cancelled, …) are claims that need probes.
    if (!/^(unknown|pending|n\/a|none|skipped)$/i.test(ci)) {
      claims.push("ci_status");
    }
  }
  if (isPresentClaim(evidence.review_score)) claims.push("review_score");
  return claims;
}

/** Map a remote claim key to the probe slot that must bind it. */
function probeKeyForClaim(claim: string): "pr" | "sha" | "ci" | "review" {
  if (claim === "pr_url" || claim === "pr_number") return "pr";
  if (claim === "commit_sha" || claim === "head_sha") return "sha";
  if (claim === "ci_status") return "ci";
  return "review";
}

function unboundClaimKeys(evidence: HandoffEvidence, claims: readonly string[]): string[] {
  const unbound: string[] = [];
  const seenProbeSlots = new Set<string>();
  for (const claim of claims) {
    const slot = probeKeyForClaim(claim);
    if (seenProbeSlots.has(slot)) {
      // Same probe slot covers multiple claim aliases (pr_url + pr_number).
      continue;
    }
    seenProbeSlots.add(slot);
    const probe = evidence.probes?.[slot];
    if (!probeBinds(probe)) {
      unbound.push(claim);
    }
  }
  return unbound;
}

function isPassStatus(status: string): boolean {
  return status.trim().toLowerCase() === "pass";
}

function isEmptyDone(evidence: HandoffEvidence): boolean {
  // Pass claimed but no work/ship/gate substance and no remote claims —
  // the empty completion shape (stricter handling still prefers invented-done
  // when remote claims are present without binding).
  const work = evidence.work?.state?.toString().trim().toLowerCase();
  const ship = evidence.ship?.state?.toString().trim().toLowerCase();
  const gate = evidence.gate?.state?.toString().trim().toLowerCase();
  const axesEmpty =
    (!work || work === "n/a" || work === "not_started") &&
    (!ship || ship === "n/a" || ship === "not_started") &&
    (!gate || gate === "n/a" || gate === "not_started");
  return axesEmpty;
}

/**
 * Validate handoff evidence against the #3120 bound-proof contract.
 *
 * Ranking when invalid under status pass:
 * 1. invented-done — remote claims present without bound proof
 * 2. empty-done — pass with no completion substance and no remote claims
 * 3. unbound-remote-claim — non-pass status but still has unbound remote claims
 * 4. shape-error — malformed proof_status / inconsistent n/a
 */
export function validateHandoffEvidence(evidence: HandoffEvidence): HandoffEvidenceValidation {
  if (!evidence || typeof evidence !== "object") {
    return {
      ok: false,
      failClass: "shape-error",
      reasons: ["evidence must be a non-null object"],
      hasRemoteClaims: false,
      unboundClaims: [],
    };
  }

  if (!isNonEmptyString(evidence.status)) {
    return {
      ok: false,
      failClass: "shape-error",
      reasons: ["status is required"],
      hasRemoteClaims: false,
      unboundClaims: [],
    };
  }

  const claims = detectRemoteClaims(evidence);
  const hasRemoteClaims = claims.length > 0;
  const unbound = unboundClaimKeys(evidence, claims);
  const proof = (evidence.proof_status ?? "").toString().trim().toLowerCase();
  const reasons: string[] = [];
  const pass = isPassStatus(evidence.status);

  // proof_status consistency
  if (hasRemoteClaims && proof === "n/a-no-remote-claim") {
    reasons.push(
      "proof_status is n/a-no-remote-claim but remote claims are present (" +
        claims.join(", ") +
        ")",
    );
  }
  if (!hasRemoteClaims && proof === "bound") {
    reasons.push("proof_status is bound but no remote claims are present");
  }

  // Core rule: pass + remote claims requires bound + probes
  if (hasRemoteClaims) {
    if (proof !== "bound") {
      reasons.push(
        `remote claims present (${claims.join(", ")}) require proof_status=bound` +
          (proof ? ` (got ${proof})` : " (missing)"),
      );
    }
    if (unbound.length > 0) {
      reasons.push(
        `missing same-turn probes for: ${unbound.join(", ")} ` +
          "(probe-then-fill: copy IDs from probe JSON/text, never recollection)",
      );
    }
  } else if (pass && (!proof || proof === "unbound")) {
    // No remote claims under pass: n/a-no-remote-claim is the legal proof_status.
    // unbound without remote claims is a soft shape issue under pass.
    if (proof === "unbound") {
      reasons.push(
        "proof_status=unbound with no remote claims; use n/a-no-remote-claim under pass",
      );
    }
  }

  // Rank fail class
  let failClass: HandoffFailClass = "none";
  let ok = reasons.length === 0;

  if (pass && hasRemoteClaims && (proof !== "bound" || unbound.length > 0)) {
    // Invented-done: complete-looking remote artifacts under pass without binding.
    failClass = "invented-done";
    ok = false;
    if (!reasons.some((r) => r.includes("invented-done"))) {
      reasons.unshift(
        "invented-done: status pass with remote PR/SHA/CI/review claims " +
          "without bound same-turn probes (stricter than empty-done)",
      );
    }
  } else if (pass && !hasRemoteClaims && isEmptyDone(evidence)) {
    failClass = "empty-done";
    ok = false;
    reasons.unshift(
      "empty-done: status pass with no work/ship/gate substance and no remote claims",
    );
  } else if (!pass && hasRemoteClaims && (proof !== "bound" || unbound.length > 0)) {
    failClass = "unbound-remote-claim";
    ok = false;
  } else if (reasons.length > 0) {
    failClass = "shape-error";
    ok = false;
  }

  // Legal partial: work done + ship not_started without PR fields → ok when not pass-with-remote
  if (
    ok &&
    evidence.status === "partial" &&
    !hasRemoteClaims &&
    (evidence.ship?.state === "not_started" || !evidence.ship?.state)
  ) {
    return {
      ok: true,
      failClass: "none",
      reasons: [],
      hasRemoteClaims: false,
      unboundClaims: [],
    };
  }

  return {
    ok,
    failClass,
    reasons,
    hasRemoteClaims,
    unboundClaims: unbound,
  };
}

/**
 * Convenience: true when status may legally be pass for this evidence.
 * Equivalent to validateHandoffEvidence(...).ok under a pass status intent.
 */
export function canClaimPass(evidence: HandoffEvidence): boolean {
  const candidate: HandoffEvidence = { ...evidence, status: "pass" };
  return validateHandoffEvidence(candidate).ok;
}
