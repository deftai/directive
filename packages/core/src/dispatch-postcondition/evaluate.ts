/**
 * Envelope-declared dispatch postcondition acceptance (#3979).
 *
 * Distinct host-boundary mechanism from handoff-evidence / invented-done
 * (#3120): that module binds child-supplied probes for builder/pre-pr
 * handoffs; this module binds parent/host verification reads before a
 * dispatch completion may be accepted as success. Keep both consumers
 * explicit. Child probes and claimed artifact ids are untrusted here.
 *
 * First-ship artifact class: obligation-bound comment-id. File-path and
 * branch postconditions are deferred. Shape-2 tool-floor telemetry is
 * complementary evidence only and never the success predicate.
 */

/** First-ship artifact class for design-critique critics. */
export type PostconditionArtifactClass = "comment-id";

/** Dispatched obligation the existence check must bind to. */
export type DispatchedObligation = {
  readonly issueNumber: number;
  readonly round: number;
  readonly seatId: string;
  /** Panel-deposit / input-ceiling id; matching comments must be strictly after. */
  readonly inputCeilingCommentId: number;
};

export type EnvelopePostcondition = {
  readonly artifactClass: PostconditionArtifactClass;
  readonly obligation: DispatchedObligation;
};

export type VerifiedThreadComment = {
  readonly id: number;
  readonly body: string;
};

/**
 * Parent/host verification input. Never accept a child-authored probe
 * snippet or claimed id as this payload.
 */
export type ParentVerification =
  | {
      readonly kind: "thread";
      readonly status: "ok";
      readonly issueNumber: number;
      readonly comments: readonly VerifiedThreadComment[];
    }
  | {
      readonly kind: "thread";
      readonly status: "unavailable";
      readonly reason: string;
    };

/** Untrusted child completion claim. Never sufficient alone. */
export type ChildHandbackClaim = {
  readonly hostSuccess?: boolean;
  readonly claimedCommentId?: number | null;
  readonly toolCallCount?: number | null;
  /** Ignored for bind (#3120 gap / Bound item 5). */
  readonly childProbes?: unknown;
};

export type DispatchPostconditionFailClass =
  | "none"
  | "missing"
  | "mismatch"
  | "unavailable"
  | "unsupported-artifact-class";

export type DispatchDeliveryStatus = "verified" | "dispatch-failure" | "unverifiable";

export type DispatchPostconditionVerdict = {
  readonly accepted: boolean;
  readonly deliveryStatus: DispatchDeliveryStatus;
  readonly failClass: DispatchPostconditionFailClass;
  readonly reasons: readonly string[];
  /** Matching obligation-bound comment id when verified. */
  readonly boundCommentId: number | null;
  /** Shape-2 telemetry echo; never alone decides acceptance. */
  readonly complementaryToolCallCount: number | null;
};

const ROLE_CRITIC_RE = /(?:^|\n)\s*role:\s*critic\b/i;

function roundFieldRe(round: number): RegExp {
  return new RegExp(`(?:^|\\n)\\s*round:\\s*${String(round)}\\b`, "i");
}

function seatFieldRe(seatId: string): RegExp {
  const escaped = seatId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\n)\\s*seat:\\s*${escaped}\\b`, "i");
}

/**
 * True when a parent-fetched comment body binds to the dispatched obligation.
 * Does not trust model: self-attestation as provenance.
 */
export function commentBindsObligation(
  comment: VerifiedThreadComment,
  obligation: DispatchedObligation,
): boolean {
  if (comment.id <= obligation.inputCeilingCommentId) return false;
  const body = comment.body;
  if (!ROLE_CRITIC_RE.test(body)) return false;
  if (!roundFieldRe(obligation.round).test(body)) return false;
  if (!seatFieldRe(obligation.seatId).test(body)) return false;
  return true;
}

function fail(
  deliveryStatus: DispatchDeliveryStatus,
  failClass: DispatchPostconditionFailClass,
  reasons: readonly string[],
  complementaryToolCallCount: number | null,
): DispatchPostconditionVerdict {
  return {
    accepted: false,
    deliveryStatus,
    failClass,
    reasons,
    boundCommentId: null,
    complementaryToolCallCount,
  };
}

/**
 * Acceptance seat: reclassify failed verification to dispatch-failure (or
 * unverifiable) before a dispatch may be booked as success.
 *
 * Unknown/unavailable parent reads never accept. Child claimed ids and
 * probes never bind. toolCallCount is complementary only.
 */
export function acceptDispatchPostcondition(input: {
  readonly postcondition: EnvelopePostcondition;
  readonly verification: ParentVerification;
  readonly handback?: ChildHandbackClaim;
}): DispatchPostconditionVerdict {
  const toolCalls =
    input.handback?.toolCallCount !== undefined && input.handback.toolCallCount !== null
      ? input.handback.toolCallCount
      : null;

  if (input.postcondition.artifactClass !== "comment-id") {
    return fail(
      "dispatch-failure",
      "unsupported-artifact-class",
      [`artifact class ${String(input.postcondition.artifactClass)} is not first-ship`],
      toolCalls,
    );
  }

  const verification = input.verification;
  if (verification.status !== "ok") {
    return fail(
      "unverifiable",
      "unavailable",
      [`parent verification unavailable: ${verification.reason}`, "unknown never accepts delivery"],
      toolCalls,
    );
  }

  const obligation = input.postcondition.obligation;
  if (verification.issueNumber !== obligation.issueNumber) {
    return fail(
      "dispatch-failure",
      "mismatch",
      [
        `verification issue ${String(verification.issueNumber)} does not match obligation issue ${String(obligation.issueNumber)}`,
      ],
      toolCalls,
    );
  }

  const bound = verification.comments.filter((comment: VerifiedThreadComment) =>
    commentBindsObligation(comment, obligation),
  );

  if (bound.length === 0) {
    const claimed = input.handback?.claimedCommentId;
    const reasons = [
      `no obligation-bound critic comment for seat ${obligation.seatId} round ${String(obligation.round)} on issue ${String(obligation.issueNumber)}`,
    ];
    if (claimed !== undefined && claimed !== null) {
      reasons.push(`child claimed comment id ${String(claimed)} is untrusted and did not bind`);
    }
    if (input.handback?.hostSuccess === true) {
      reasons.push("host success claim reclassified to dispatch-failure");
    }
    if (toolCalls === 0) {
      reasons.push("zero tool calls is complementary evidence only");
    }
    return fail("dispatch-failure", "missing", reasons, toolCalls);
  }

  // Prefer the earliest binding comment after the ceiling, unless the child
  // claimed a specific id that is among the parent-bound set.
  const sorted = [...bound].sort((a, b) => a.id - b.id);
  const earliest = sorted[0];
  if (earliest === undefined) {
    return fail("dispatch-failure", "missing", ["bound set empty after sort"], toolCalls);
  }

  // Child claimed ids never bind alone. On repeat seat/round dispatch, a
  // bad/nonexistent claim must not credit an earlier matching comment as
  // success for this handback (Prefer-A returned failure).
  const claimed = input.handback?.claimedCommentId;
  if (
    claimed !== undefined &&
    claimed !== null &&
    !bound.some((comment: VerifiedThreadComment) => comment.id === claimed)
  ) {
    return fail(
      "dispatch-failure",
      "mismatch",
      [
        `child claimed comment id ${String(claimed)} is not among obligation-bound parent reads`,
        "earlier matching comments do not credit a bad or nonexistent handback claim",
        "child-supplied artifact ids are untrusted",
      ],
      toolCalls,
    );
  }

  const chosen =
    claimed !== undefined && claimed !== null
      ? (bound.find((comment: VerifiedThreadComment) => comment.id === claimed) ?? earliest)
      : earliest;

  return {
    accepted: true,
    deliveryStatus: "verified",
    failClass: "none",
    reasons: [],
    boundCommentId: chosen.id,
    complementaryToolCallCount: toolCalls,
  };
}
