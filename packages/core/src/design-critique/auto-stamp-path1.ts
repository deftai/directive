/**
 * Lean-cite-only candidate-record gate for #3640 auto-stamp path-1 (#4592).
 *
 * Dest is Stop 1 plus successor lean plus unpublished path-1 that cites only
 * the lean. Refuse the path-1 write on any published pain-coverage reason.
 * Skip the ingest-ready remaining-set write when that write is refused.
 * Live-thread evaluateCompletedArcRecord is missing-record and is not this gate.
 * Parent must supply a non-empty plain-English summary for the unpublished body (#5415).
 */

import {
  type CompletedArcBlockReason,
  type CompletedArcVerdict,
  evaluateCompletedArcRecord,
  isSuccessorLeanBody,
  type ThreadComment,
} from "./completed-arc-record.js";
import {
  evaluatePanelSeatDeliveryFromThread,
  type PanelSeatDeliveryVerdict,
  type PanelSeatHandback,
} from "./panel-handback-acceptance.js";

export const PAIN_COVERAGE_BLOCK_REASONS = [
  "missing-pain",
  "malformed-pain",
  "unrelieved-pain",
  "unresolved-pain-audit",
] as const satisfies readonly CompletedArcBlockReason[];

export type PainCoverageBlockReason = (typeof PAIN_COVERAGE_BLOCK_REASONS)[number];

const PAIN_COVERAGE_REASON_SET: ReadonlySet<string> = new Set(PAIN_COVERAGE_BLOCK_REASONS);

export function isPainCoverageBlockReason(
  reason: CompletedArcBlockReason,
): reason is PainCoverageBlockReason {
  return PAIN_COVERAGE_REASON_SET.has(reason);
}

/** Returned-failure shape — empty summary is free (no throw/reject/abort; #5010 / #5415). */
export type LeanCiteOnlyPath1BodyResult =
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly reason: "empty-plain-english-summary" };

/**
 * Unpublished path-1 body that cites only the successor lean. No table id.
 * Requires a parent-supplied non-empty plain-English summary (#5415).
 * Empty summary returns `{ ok:false }` — callers refuse via evaluateAutoStampPath1Write.
 */
export function leanCiteOnlyPath1Body(
  successorLeanId: number,
  plainEnglishSummary: string,
): LeanCiteOnlyPath1BodyResult {
  const summary = plainEnglishSummary.trim();
  if (summary.length === 0) {
    return { ok: false, reason: "empty-plain-english-summary" };
  }
  return {
    ok: true,
    body:
      "model: grok-4.6\nrole: parent\n\n" +
      "## In plain English\n\n" +
      summary +
      "\n\n" +
      "design-critique: synthesis accepted, because agents agreed (empty disagreement set)\n\n" +
      `Bound contract: successor lean ${String(successorLeanId)}.\n`,
  };
}

/** Body without ## In plain English — used only to surface missing-plain-english on refuse. */
function leanCiteOnlyPath1BodyMissingSummary(successorLeanId: number): string {
  return (
    "model: grok-4.6\nrole: parent\n\n" +
    "design-critique: synthesis accepted, because agents agreed (empty disagreement set)\n\n" +
    `Bound contract: successor lean ${String(successorLeanId)}.\n`
  );
}

export function latestSuccessorLeanComment(
  comments: readonly ThreadComment[],
): ThreadComment | undefined {
  let latest: ThreadComment | undefined;
  for (const comment of comments) {
    if (!isSuccessorLeanBody(comment.body)) continue;
    if (latest === undefined || comment.id > latest.id) latest = comment;
  }
  return latest;
}

function nextUnpublishedCommentId(comments: readonly ThreadComment[], leanId: number): number {
  let maxId = leanId;
  for (const comment of comments) {
    if (comment.id > maxId) maxId = comment.id;
  }
  return maxId + 1;
}

export type AutoStampPath1WriteInput = {
  readonly comments: readonly ThreadComment[];
  readonly issueNumber?: number;
  readonly unpublishedCommentId?: number;
  /**
   * Parent-authored plain-English summary for the unpublished path-1 body (#5415).
   * Absent or trim-empty refuses both writes; recovery is candidate repair.
   */
  readonly plainEnglishSummary?: string;
  /**
   * Optional child handbacks. When present with a panel-deposit, each is
   * reclassified through evaluatePanelSeatDelivery before it can count as a
   * posted same-round sibling (#3979). Does not close #3850.
   */
  readonly handbacks?: readonly PanelSeatHandback[];
};

export type AutoStampPath1WriteVerdict = {
  readonly writePath1: boolean;
  readonly writeIngestReadyRemainingSet: boolean;
  readonly unpublished: ThreadComment | null;
  readonly candidate: CompletedArcVerdict;
  /** Panel postcondition consumption when deposit+seats+issueNumber admit it. */
  readonly panelDelivery: PanelSeatDeliveryVerdict | null;
};

function attachPanelDelivery(input: AutoStampPath1WriteInput): PanelSeatDeliveryVerdict | null {
  if (input.issueNumber === undefined) return null;
  return evaluatePanelSeatDeliveryFromThread({
    issueNumber: input.issueNumber,
    comments: input.comments,
    handbacks: input.handbacks,
  });
}

function refuse(
  unpublished: ThreadComment | null,
  candidate: CompletedArcVerdict,
  panelDelivery: PanelSeatDeliveryVerdict | null,
): AutoStampPath1WriteVerdict {
  return {
    writePath1: false,
    writeIngestReadyRemainingSet: false,
    unpublished,
    candidate,
    panelDelivery,
  };
}

function path1MissingSummaryDetail(evaluatorDetail: string): string {
  const withoutRecovery = evaluatorDetail.replace(/; recovery:.*$/s, "").trim();
  const leanParts = withoutRecovery
    .split("; ")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part.startsWith("cited lean"));
  if (leanParts.length > 0) {
    return (
      leanParts.join("; ") +
      "; path-1 unpublished candidate also lacks a non-empty plainEnglishSummary; " +
      "recovery: patch named published lean id(s) and repair the candidate summary " +
      "(not a GitHub patch of the synthetic id), then re-evaluate"
    );
  }
  return (
    "path-1 unpublished candidate lacks a non-empty plainEnglishSummary; " +
    "recovery: repair the candidate summary (not a GitHub patch of the synthetic id), " +
    "then re-evaluate"
  );
}

/**
 * Production caller for #3640 auto-stamp path-1.
 *
 * Parent calls this before any path-1 write. Constructs the dest candidate
 * (lean citation only) with a required non-empty plain-English summary (#5415).
 * Refuses both the path-1 write and the ingest-ready remaining-set write when
 * that candidate is not complete. Chip ingest-ready only when that unpublished
 * candidate is complete. Live-thread evaluateCompletedArcRecord is
 * missing-record and is not this gate. English Pain-audit headings are not
 * targeting; criticEnvelopes reads the closed audit-targets field. Does not
 * grow resolveAutoStampCatalogChip. Does not treat operatorVerbApplySet
 * autoStamp as this write (#4648).
 *
 * When issueNumber, handbacks, and a seat-bearing panel-deposit are present,
 * evaluatePanelSeatDeliveryFromThread (#3979) must verify; fabricated or
 * failed seats refuse both writes. Full #3850 panel-completeness remain
 * behavioural for callers that omit handbacks.
 */
export function evaluateAutoStampPath1Write(
  input: AutoStampPath1WriteInput,
): AutoStampPath1WriteVerdict {
  const panelDelivery = attachPanelDelivery(input);
  const lean = latestSuccessorLeanComment(input.comments);
  if (lean === undefined) {
    return refuse(
      null,
      evaluateCompletedArcRecord({
        comments: input.comments,
        issueNumber: input.issueNumber,
      }),
      panelDelivery,
    );
  }
  const fallbackId = nextUnpublishedCommentId(input.comments, lean.id);
  const unpublishedId =
    input.unpublishedCommentId !== undefined && input.unpublishedCommentId > lean.id
      ? input.unpublishedCommentId
      : fallbackId;
  const summary = input.plainEnglishSummary?.trim() ?? "";
  const path1Body = leanCiteOnlyPath1Body(lean.id, summary);
  const unpublished: ThreadComment = {
    id: unpublishedId,
    body: path1Body.ok ? path1Body.body : leanCiteOnlyPath1BodyMissingSummary(lean.id),
  };
  const candidate = evaluateCompletedArcRecord({
    comments: [...input.comments, unpublished],
    issueNumber: input.issueNumber,
  });
  if (summary.length === 0) {
    // Synthetic unpublished id is not on GitHub — recovery is candidate repair (#5415).
    // Keep any published lean failure text so operators still see which live id to patch.
    const path1Candidate: CompletedArcVerdict =
      candidate.status === "blocked" && candidate.reason === "missing-plain-english"
        ? {
            status: "blocked",
            reason: "missing-plain-english",
            detail: path1MissingSummaryDetail(candidate.detail),
          }
        : candidate;
    return refuse(unpublished, path1Candidate, panelDelivery);
  }
  if (candidate.status === "complete") {
    // When handbacks were supplied against a seat-bearing deposit, panel
    // verification failure refuses both writes (fabricated / missing /
    // unverifiable seats must not stamp path-1).
    if (
      input.handbacks !== undefined &&
      panelDelivery !== null &&
      (panelDelivery.dispatchFailedSeatIds.length > 0 ||
        panelDelivery.unverifiableSeatIds.length > 0 ||
        !panelDelivery.allExpectedVerified)
    ) {
      return refuse(unpublished, candidate, panelDelivery);
    }
    return {
      writePath1: true,
      writeIngestReadyRemainingSet: true,
      unpublished,
      candidate,
      panelDelivery,
    };
  }
  return refuse(unpublished, candidate, panelDelivery);
}
