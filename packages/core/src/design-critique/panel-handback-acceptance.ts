/**
 * Design-critique panel consumption of dispatch postcondition (#3979).
 *
 * Mandatory first-ship seat: before a child handback may count as a posted
 * same-round sibling, run acceptDispatchPostcondition over parent/host
 * verification reads. Failed verification is dispatch-failure, not success.
 *
 * Does not close #3850's held behavioural panel-completeness half: a parent
 * that binds on a partial set of *verified* posts is still unobserved. This
 * module only makes unverified / fabricated handbacks uncountable.
 */

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

export type ExpectedPanelSeat = {
  readonly seatId: string;
};

export type PanelSeatHandback = {
  readonly seatId: string;
  readonly hostSuccess?: boolean;
  readonly claimedCommentId?: number | null;
  readonly toolCallCount?: number | null;
  readonly childProbes?: unknown;
};

export type PanelSeatDeliveryRow = {
  readonly seatId: string;
  readonly verdict: DispatchPostconditionVerdict;
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
 * source. Each handback is reclassified through acceptDispatchPostcondition
 * before it may count as a posted same-round sibling.
 */
export function evaluatePanelSeatDelivery(input: {
  readonly issueNumber: number;
  readonly round: number;
  readonly inputCeilingCommentId: number;
  readonly expectedSeats: readonly ExpectedPanelSeat[];
  readonly verification: ParentVerification;
  readonly handbacks?: readonly PanelSeatHandback[];
}): PanelSeatDeliveryVerdict {
  const handbackBySeat = new Map<string, PanelSeatHandback>();
  for (const handback of input.handbacks ?? []) {
    handbackBySeat.set(handback.seatId, handback);
  }

  const rows: PanelSeatDeliveryRow[] = [];
  for (const seat of input.expectedSeats) {
    const handback = handbackBySeat.get(seat.seatId);
    // Missing handback for this dispatch must not inherit an earlier matching
    // comment as success for the current obligation (repeat-dispatch case).
    if (handback === undefined) {
      if (input.verification.status === "unavailable") {
        rows.push({
          seatId: seat.seatId,
          verdict: {
            accepted: false,
            deliveryStatus: "unverifiable",
            failClass: "unavailable",
            reasons: [
              `parent verification unavailable: ${input.verification.reason}`,
              "unknown never accepts delivery",
            ],
            boundCommentId: null,
            complementaryToolCallCount: null,
          },
          countsAsPostedSibling: false,
        });
        continue;
      }
      rows.push({
        seatId: seat.seatId,
        verdict: {
          accepted: false,
          deliveryStatus: "dispatch-failure",
          failClass: "missing",
          reasons: [
            `no handback for seat ${seat.seatId} on this dispatch obligation`,
            "earlier matching comments do not satisfy a missing handback",
          ],
          boundCommentId: null,
          complementaryToolCallCount: null,
        },
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
          issueNumber: input.issueNumber,
          round: input.round,
          seatId: seat.seatId,
          inputCeilingCommentId: input.inputCeilingCommentId,
        },
      },
      verification: input.verification,
      handback: claim,
    });
    // Accepted only when this dispatch's handback binds; earlier matching
    // comments alone never flip countsAsPostedSibling (repeat-dispatch).
    rows.push({
      seatId: seat.seatId,
      verdict,
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
  });
}
