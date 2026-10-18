/**
 * Design-critique panel consumption of dispatch postcondition (#3979 / #5486).
 *
 * Mandatory first-ship seat: before a child handback may count as a posted
 * same-round sibling, run acceptDispatchPostcondition over parent/host
 * verification reads. Failed verification is dispatch-failure, not success.
 *
 * Remint-3 stage-(0): this module is the named file-path caller. It admits
 * artifact class `file-path`, constructs the parent-written outbox manifest
 * (stage-(0) ceiling with dispatch-sha), and returns a non-numeric
 * `boundArtifactId` alongside `boundCommentId`. Comment-id path stays on
 * `acceptDispatchPostcondition` unchanged.
 *
 * Does not close #3850's held behavioural panel-completeness half: a parent
 * that binds on a partial set of *verified* posts is still unobserved. This
 * module only makes unverified / fabricated handbacks uncountable.
 */

import { createHash } from "node:crypto";
import {
  acceptDispatchPostcondition,
  type ChildHandbackClaim,
  type DispatchPostconditionVerdict,
  type ParentVerification,
} from "../dispatch-postcondition/index.js";
import { isPanelDepositBody, type ThreadComment } from "./completed-arc-record.js";

const SEAT_LINE_RE = /(?:^|\n)\s*seat:\s*(\S+)/gi;
const FAMILIES_FIELD_RE = /(?:^|\n)\s*families:\s*([^\n]+)/i;
const ROUND_FIELD_RE = /(?:^|\n)\s*round:\s*(\d+)\b/i;
const INPUT_CEILING_RE = /(?:^|\n)\s*input-ceiling:\s*(\d+)\b/i;
const SIBLINGS_RE = /(?:^|\n)\s*siblings:\s*(\d+)\b/i;
const DISPATCH_SHA_RE = /^[0-9a-f]{7,40}$/i;

/** #5486 stage-(0): design-critique admits file-path beside comment-id. */
export type DesignCritiquePostconditionArtifactClass = "comment-id" | "file-path";

/**
 * Ceiling kind for panel delivery. Comment-id path keeps numeric
 * `inputCeilingCommentId`. File-path stage-(0) ceiling is dispatch-sha plus
 * the parent-written outbox manifest (not a later archive stage).
 */
export type DesignCritiqueCeilingKind = "comment-id" | "dispatch-sha-outbox-manifest";

export const OUTBOX_MANIFEST_SCHEMA = "deft.design-critique.outbox-manifest.v1" as const;

export type OutboxManifestSeatEntry = {
  readonly seatId: string;
  /** Relative path under the staging outbox root for this seat's artifact. */
  readonly artifactRelPath: string;
  readonly exclusiveCreate: true;
};

export type OutboxManifest = {
  readonly schema: typeof OUTBOX_MANIFEST_SCHEMA;
  readonly dispatchSha: string;
  readonly targetId: string;
  readonly targetPath: string | null;
  readonly round: number;
  readonly seats: readonly OutboxManifestSeatEntry[];
  readonly createdAt: string;
};

/**
 * Generalized obligation for file-path seats (#5486). `issueNumber` is
 * optional / N/A; identity binds target-id/path + dispatch-sha + manifest.
 */
export type FilePathDispatchedObligation = {
  readonly targetId: string;
  readonly targetPath?: string | null;
  readonly issueNumber?: number | null;
  readonly round: number;
  readonly seatId: string;
  readonly dispatchSha: string;
  readonly outboxManifest: OutboxManifest;
};

export type FilePathParentVerification =
  | {
      readonly kind: "outbox";
      readonly status: "ok";
      readonly dispatchSha: string;
      readonly manifest: OutboxManifest;
      /** Parent-read seat artifact bytes keyed by seatId (not child probes). */
      readonly seatArtifacts: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: "outbox";
      readonly status: "unavailable";
      readonly reason: string;
    };

export type DesignCritiquePostconditionVerdict = DispatchPostconditionVerdict & {
  /** Non-numeric bound artifact id for file-path; null on comment-id path. */
  readonly boundArtifactId: string | null;
  readonly ceilingKind: DesignCritiqueCeilingKind;
};

export type ExpectedPanelSeat = {
  readonly seatId: string;
};

export type PanelSeatHandback = {
  readonly seatId: string;
  readonly hostSuccess?: boolean;
  readonly claimedCommentId?: number | null;
  /** Claimed file-path artifact id; untrusted alone (parent read binds). */
  readonly claimedArtifactId?: string | null;
  readonly toolCallCount?: number | null;
  readonly childProbes?: unknown;
};

export type PanelSeatDeliveryRow = {
  readonly seatId: string;
  readonly verdict: DesignCritiquePostconditionVerdict;
  /** True only when verification accepted; never from hostSuccess alone. */
  readonly countsAsPostedSibling: boolean;
};

export type PanelSeatDeliveryVerdict = {
  readonly rows: readonly PanelSeatDeliveryRow[];
  readonly verifiedPostedSeatIds: readonly string[];
  readonly dispatchFailedSeatIds: readonly string[];
  readonly unverifiableSeatIds: readonly string[];
  /**
   * True when every expected seat verified. Advisory for parents; #3850 still
   * holds that nothing forces bind to wait on this conjunct alone.
   */
  readonly allExpectedVerified: boolean;
};

export type ParsedPanelDeposit = {
  readonly commentId: number;
  readonly round: number;
  readonly inputCeilingCommentId: number;
  readonly siblings: number | null;
  readonly seatIds: readonly string[];
};

function parsePositiveInt(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function withCommentIdVerdict(
  verdict: DispatchPostconditionVerdict,
): DesignCritiquePostconditionVerdict {
  return {
    ...verdict,
    boundArtifactId: null,
    ceilingKind: "comment-id",
  };
}

function filePathFail(
  deliveryStatus: DesignCritiquePostconditionVerdict["deliveryStatus"],
  failClass: DesignCritiquePostconditionVerdict["failClass"],
  reasons: readonly string[],
  complementaryToolCallCount: number | null,
): DesignCritiquePostconditionVerdict {
  return {
    accepted: false,
    deliveryStatus,
    failClass,
    reasons,
    boundCommentId: null,
    complementaryToolCallCount,
    boundArtifactId: null,
    ceilingKind: "dispatch-sha-outbox-manifest",
  };
}

/** Non-numeric bound artifact id: scheme + seat + short dispatch sha. */
export function boundArtifactIdForSeat(seatId: string, dispatchSha: string): string {
  const short = dispatchSha.slice(0, 12).toLowerCase();
  return `outbox:${seatId}@${short}`;
}

/**
 * Stage-(0) constructs the outbox-manifest artifact. Do not defer construction
 * to archive stage (b). Seats are exclusive-create; N>=3 when isolation asks.
 */
export function constructOutboxManifest(input: {
  readonly dispatchSha: string;
  readonly targetId: string;
  readonly targetPath?: string | null;
  readonly round: number;
  readonly seatIds: readonly string[];
  readonly createdAt?: string;
}): OutboxManifest {
  if (!DISPATCH_SHA_RE.test(input.dispatchSha)) {
    throw new Error(`constructOutboxManifest: invalid dispatchSha ${input.dispatchSha}`);
  }
  if (input.targetId.trim().length === 0) {
    throw new Error("constructOutboxManifest: targetId required");
  }
  if (input.seatIds.length === 0) {
    throw new Error("constructOutboxManifest: at least one seat required");
  }
  const seen = new Set<string>();
  const seats: OutboxManifestSeatEntry[] = [];
  for (const seatId of input.seatIds) {
    const id = seatId.trim();
    if (id.length === 0 || seen.has(id)) {
      throw new Error(`constructOutboxManifest: duplicate or empty seat ${seatId}`);
    }
    seen.add(id);
    seats.push({
      seatId: id,
      artifactRelPath: `seats/${id}.md`,
      exclusiveCreate: true,
    });
  }
  return {
    schema: OUTBOX_MANIFEST_SCHEMA,
    dispatchSha: input.dispatchSha.toLowerCase(),
    targetId: input.targetId,
    targetPath: input.targetPath ?? null,
    round: input.round,
    seats,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export function outboxManifestDigest(manifest: OutboxManifest): string {
  return createHash("sha256").update(JSON.stringify(manifest), "utf8").digest("hex");
}

/**
 * File-path acceptance: parent-read binds obligation fields via dispatch-sha +
 * outbox manifest seat entry + parent-fetched artifact bytes. Bare file
 * existence never accepts. Child claimedArtifactId is untrusted alone.
 */
export function acceptFilePathDispatchPostcondition(input: {
  readonly obligation: FilePathDispatchedObligation;
  readonly verification: FilePathParentVerification;
  readonly handback?: PanelSeatHandback;
}): DesignCritiquePostconditionVerdict {
  const toolCalls =
    input.handback?.toolCallCount !== undefined && input.handback.toolCallCount !== null
      ? input.handback.toolCallCount
      : null;

  const expectedId = boundArtifactIdForSeat(input.obligation.seatId, input.obligation.dispatchSha);

  if (input.verification.status !== "ok") {
    return filePathFail(
      "unverifiable",
      "unavailable",
      [
        `parent verification unavailable: ${input.verification.reason}`,
        "unknown never accepts delivery",
      ],
      toolCalls,
    );
  }

  const verification = input.verification;
  if (verification.dispatchSha.toLowerCase() !== input.obligation.dispatchSha.toLowerCase()) {
    return filePathFail(
      "dispatch-failure",
      "mismatch",
      [
        `verification dispatchSha ${verification.dispatchSha} does not match obligation ${input.obligation.dispatchSha}`,
      ],
      toolCalls,
    );
  }

  if (verification.manifest.schema !== OUTBOX_MANIFEST_SCHEMA) {
    return filePathFail(
      "dispatch-failure",
      "mismatch",
      [`outbox manifest schema ${String(verification.manifest.schema)} is not stage-(0)`],
      toolCalls,
    );
  }

  if (
    verification.manifest.dispatchSha.toLowerCase() !==
      input.obligation.dispatchSha.toLowerCase() ||
    verification.manifest.targetId !== input.obligation.targetId ||
    verification.manifest.round !== input.obligation.round
  ) {
    return filePathFail(
      "dispatch-failure",
      "mismatch",
      ["outbox manifest does not bind obligation targetId/round/dispatchSha"],
      toolCalls,
    );
  }

  const recorded = input.obligation.outboxManifest;
  if (outboxManifestDigest(verification.manifest) !== outboxManifestDigest(recorded)) {
    return filePathFail(
      "dispatch-failure",
      "mismatch",
      [
        "parent-read outbox manifest does not match obligation.outboxManifest",
        "changed manifests must not count as verified",
      ],
      toolCalls,
    );
  }

  // Explicit obligation.targetPath must match the parent-read manifest; omitted
  // targetPath still binds via the recorded outboxManifest digest above.
  if (
    input.obligation.targetPath !== undefined &&
    (verification.manifest.targetPath ?? null) !== (input.obligation.targetPath ?? null)
  ) {
    return filePathFail(
      "dispatch-failure",
      "mismatch",
      [
        `outbox manifest targetPath ${String(verification.manifest.targetPath)} does not match obligation targetPath ${String(input.obligation.targetPath)}`,
      ],
      toolCalls,
    );
  }

  const seatEntry = verification.manifest.seats.find(
    (seat) => seat.seatId === input.obligation.seatId,
  );
  if (seatEntry === undefined || seatEntry.exclusiveCreate !== true) {
    return filePathFail(
      "dispatch-failure",
      "missing",
      [
        `no exclusive-create outbox seat entry for ${input.obligation.seatId}`,
        "bare file existence does not satisfy file-path postcondition",
      ],
      toolCalls,
    );
  }

  const artifact = verification.seatArtifacts[input.obligation.seatId];
  if (artifact === undefined || artifact.trim().length === 0) {
    const claimed = input.handback?.claimedArtifactId;
    const reasons = [
      `no parent-read outbox artifact bytes for seat ${input.obligation.seatId}`,
      "bare file existence does not bind",
    ];
    if (claimed !== undefined && claimed !== null) {
      reasons.push(`child claimed artifact id ${claimed} is untrusted and did not bind`);
    }
    if (input.handback?.hostSuccess === true) {
      reasons.push("host success claim reclassified to dispatch-failure");
    }
    return filePathFail("dispatch-failure", "missing", reasons, toolCalls);
  }

  // Obligation fields must appear in the parent-read artifact body.
  const body = artifact;
  if (!/(?:^|\n)\s*role:\s*critic\b/i.test(body)) {
    return filePathFail(
      "dispatch-failure",
      "mismatch",
      ["outbox artifact missing role: critic"],
      toolCalls,
    );
  }
  if (!new RegExp(`(?:^|\\n)\\s*round:\\s*${String(input.obligation.round)}\\b`, "i").test(body)) {
    return filePathFail(
      "dispatch-failure",
      "mismatch",
      [`outbox artifact missing round: ${String(input.obligation.round)}`],
      toolCalls,
    );
  }
  // Exact seat token match — `\b` after "grok" also matches "grok-backup".
  const seatLine = body.match(/(?:^|\n)\s*seat:\s*(\S+)/i);
  const seatValue = seatLine?.[1] ?? null;
  if (seatValue === null || seatValue !== input.obligation.seatId) {
    return filePathFail(
      "dispatch-failure",
      "mismatch",
      [
        seatValue === null
          ? `outbox artifact missing seat: ${input.obligation.seatId}`
          : `outbox artifact seat: ${seatValue} does not exactly match obligation seat ${input.obligation.seatId}`,
      ],
      toolCalls,
    );
  }

  const claimed = input.handback?.claimedArtifactId;
  if (claimed !== undefined && claimed !== null && claimed !== expectedId) {
    return filePathFail(
      "dispatch-failure",
      "mismatch",
      [
        `child claimed artifact id ${claimed} is not the obligation-bound id ${expectedId}`,
        "child-supplied artifact ids are untrusted",
      ],
      toolCalls,
    );
  }

  return {
    accepted: true,
    deliveryStatus: "verified",
    failClass: "none",
    reasons: [],
    boundCommentId: null,
    complementaryToolCallCount: toolCalls,
    boundArtifactId: expectedId,
    ceilingKind: "dispatch-sha-outbox-manifest",
  };
}

/** Parse seat / round / ceiling fields from a panel-deposit body. */
export function parsePanelDeposit(comment: ThreadComment): ParsedPanelDeposit | null {
  if (!isPanelDepositBody(comment.body)) return null;
  const round = parsePositiveInt(comment.body.match(ROUND_FIELD_RE)?.[1]);
  const ceiling = parsePositiveInt(comment.body.match(INPUT_CEILING_RE)?.[1]);
  if (round === null || ceiling === null) return null;
  const seatIds: string[] = [];
  const seen = new Set<string>();
  const seatRe = new RegExp(SEAT_LINE_RE.source, "gi");
  for (const match of comment.body.matchAll(seatRe)) {
    const id = match[1]?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    seatIds.push(id);
  }
  // Canonical deposits list seats under families: with no seat: lines.
  if (seatIds.length === 0) {
    const familiesRaw = comment.body.match(FAMILIES_FIELD_RE)?.[1] ?? "";
    for (const part of familiesRaw.split(",")) {
      const id = part.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      seatIds.push(id);
    }
  }
  const siblings = parsePositiveInt(comment.body.match(SIBLINGS_RE)?.[1]);
  return {
    commentId: comment.id,
    round,
    inputCeilingCommentId: ceiling,
    siblings,
    seatIds,
  };
}

export function latestPanelDeposit(comments: readonly ThreadComment[]): ParsedPanelDeposit | null {
  let latest: ParsedPanelDeposit | null = null;
  for (const comment of comments) {
    const parsed = parsePanelDeposit(comment);
    if (parsed === null) continue;
    if (latest === null || parsed.commentId > latest.commentId) latest = parsed;
  }
  return latest;
}

/**
 * First-ship panel consumer. Parent-fetched thread comments are the bind
 * source for comment-id. File-path seats bind through
 * acceptFilePathDispatchPostcondition + stage-(0) outbox manifest.
 */
export function evaluatePanelSeatDelivery(input: {
  readonly issueNumber?: number;
  readonly round: number;
  readonly inputCeilingCommentId?: number;
  readonly expectedSeats: readonly ExpectedPanelSeat[];
  readonly verification?: ParentVerification;
  readonly handbacks?: readonly PanelSeatHandback[];
  readonly artifactClass?: DesignCritiquePostconditionArtifactClass;
  readonly filePathObligation?: Omit<FilePathDispatchedObligation, "seatId" | "round">;
  readonly filePathVerification?: FilePathParentVerification;
}): PanelSeatDeliveryVerdict {
  const artifactClass = input.artifactClass ?? "comment-id";
  const handbackBySeat = new Map<string, PanelSeatHandback>();
  for (const handback of input.handbacks ?? []) {
    handbackBySeat.set(handback.seatId, handback);
  }

  const rows: PanelSeatDeliveryRow[] = [];
  for (const seat of input.expectedSeats) {
    const handback = handbackBySeat.get(seat.seatId);

    if (artifactClass === "file-path") {
      if (input.filePathObligation === undefined) {
        rows.push({
          seatId: seat.seatId,
          verdict: filePathFail(
            "dispatch-failure",
            "missing",
            ["file-path artifact class requires filePathObligation (stage-0 ceiling)"],
            null,
          ),
          countsAsPostedSibling: false,
        });
        continue;
      }
      if (input.filePathVerification === undefined) {
        rows.push({
          seatId: seat.seatId,
          verdict: filePathFail(
            "unverifiable",
            "unavailable",
            ["file-path parent verification missing", "unknown never accepts delivery"],
            null,
          ),
          countsAsPostedSibling: false,
        });
        continue;
      }
      if (handback === undefined) {
        if (input.filePathVerification.status === "unavailable") {
          rows.push({
            seatId: seat.seatId,
            verdict: filePathFail(
              "unverifiable",
              "unavailable",
              [
                `parent verification unavailable: ${input.filePathVerification.reason}`,
                "unknown never accepts delivery",
              ],
              null,
            ),
            countsAsPostedSibling: false,
          });
          continue;
        }
        rows.push({
          seatId: seat.seatId,
          verdict: filePathFail(
            "dispatch-failure",
            "missing",
            [
              `no handback for seat ${seat.seatId} on this dispatch obligation`,
              "earlier matching artifacts do not satisfy a missing handback",
            ],
            null,
          ),
          countsAsPostedSibling: false,
        });
        continue;
      }
      const verdict = acceptFilePathDispatchPostcondition({
        obligation: {
          ...input.filePathObligation,
          seatId: seat.seatId,
          round: input.round,
        },
        verification: input.filePathVerification,
        handback,
      });
      rows.push({
        seatId: seat.seatId,
        verdict,
        countsAsPostedSibling: verdict.accepted,
      });
      continue;
    }

    // comment-id path (unchanged GitHub-issue consumer)
    const issueNumber = input.issueNumber;
    const inputCeilingCommentId = input.inputCeilingCommentId;
    const verification = input.verification;
    if (
      issueNumber === undefined ||
      inputCeilingCommentId === undefined ||
      verification === undefined
    ) {
      rows.push({
        seatId: seat.seatId,
        verdict: withCommentIdVerdict({
          accepted: false,
          deliveryStatus: "dispatch-failure",
          failClass: "missing",
          reasons: [
            "comment-id path requires issueNumber, inputCeilingCommentId, and verification",
          ],
          boundCommentId: null,
          complementaryToolCallCount: null,
        }),
        countsAsPostedSibling: false,
      });
      continue;
    }

    if (handback === undefined) {
      if (verification.status === "unavailable") {
        rows.push({
          seatId: seat.seatId,
          verdict: withCommentIdVerdict({
            accepted: false,
            deliveryStatus: "unverifiable",
            failClass: "unavailable",
            reasons: [
              `parent verification unavailable: ${verification.reason}`,
              "unknown never accepts delivery",
            ],
            boundCommentId: null,
            complementaryToolCallCount: null,
          }),
          countsAsPostedSibling: false,
        });
        continue;
      }
      rows.push({
        seatId: seat.seatId,
        verdict: withCommentIdVerdict({
          accepted: false,
          deliveryStatus: "dispatch-failure",
          failClass: "missing",
          reasons: [
            `no handback for seat ${seat.seatId} on this dispatch obligation`,
            "earlier matching comments do not satisfy a missing handback",
          ],
          boundCommentId: null,
          complementaryToolCallCount: null,
        }),
        countsAsPostedSibling: false,
      });
      continue;
    }
    const claim: ChildHandbackClaim = {
      hostSuccess: handback.hostSuccess,
      claimedCommentId: handback.claimedCommentId,
      toolCallCount: handback.toolCallCount,
      childProbes: handback.childProbes,
    };
    const verdict = acceptDispatchPostcondition({
      postcondition: {
        artifactClass: "comment-id",
        obligation: {
          issueNumber,
          round: input.round,
          seatId: seat.seatId,
          inputCeilingCommentId,
        },
      },
      verification,
      handback: claim,
    });
    rows.push({
      seatId: seat.seatId,
      verdict: withCommentIdVerdict(verdict),
      countsAsPostedSibling: verdict.accepted,
    });
  }

  const verifiedPostedSeatIds = rows
    .filter((row) => row.countsAsPostedSibling)
    .map((row) => row.seatId);
  const dispatchFailedSeatIds = rows
    .filter((row) => row.verdict.deliveryStatus === "dispatch-failure")
    .map((row) => row.seatId);
  const unverifiableSeatIds = rows
    .filter((row) => row.verdict.deliveryStatus === "unverifiable")
    .map((row) => row.seatId);

  return {
    rows,
    verifiedPostedSeatIds,
    dispatchFailedSeatIds,
    unverifiableSeatIds,
    allExpectedVerified: verifiedPostedSeatIds.length === input.expectedSeats.length,
  };
}

/**
 * Production helper: build panel delivery verdict from a parent-fetched
 * thread plus the latest panel-deposit's expected seats.
 *
 * When verification is unavailable, every expected seat is unverifiable
 * (unknown never accepts). Handbacks never become posted without bind.
 */
export function evaluatePanelSeatDeliveryFromThread(input: {
  readonly issueNumber: number;
  readonly comments: readonly ThreadComment[];
  readonly verificationStatus?: "ok" | "unavailable";
  readonly unavailableReason?: string;
  readonly handbacks?: readonly PanelSeatHandback[];
  readonly expectedSeatIds?: readonly string[];
}): PanelSeatDeliveryVerdict | null {
  const deposit = latestPanelDeposit(input.comments);
  if (deposit === null) return null;
  // Expected seats come from the caller override or the deposit (seat:/families:).
  // Child handbacks never define the expected set — a partial return must not
  // shrink the conjunct and make allExpectedVerified true.
  const expectedIds = input.expectedSeatIds !== undefined ? input.expectedSeatIds : deposit.seatIds;
  // Seat-bound verification is required once a panel-deposit is present.
  if (expectedIds.length === 0) return null;

  const status = input.verificationStatus ?? "ok";
  const verification: ParentVerification =
    status === "unavailable"
      ? {
          kind: "thread",
          status: "unavailable",
          reason: input.unavailableReason ?? "thread read unavailable",
        }
      : {
          kind: "thread",
          status: "ok",
          issueNumber: input.issueNumber,
          comments: input.comments.map((comment) => ({
            id: comment.id,
            body: comment.body,
          })),
        };

  return evaluatePanelSeatDelivery({
    issueNumber: input.issueNumber,
    round: deposit.round,
    inputCeilingCommentId: deposit.inputCeilingCommentId,
    expectedSeats: expectedIds.map((seatId) => ({ seatId })),
    verification,
    handbacks: input.handbacks,
    artifactClass: "comment-id",
  });
}
