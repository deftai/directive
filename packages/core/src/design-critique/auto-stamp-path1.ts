/**
 * Lean-cite-only candidate-record gate for #3640 auto-stamp path-1 (#4592).
 *
 * Dest is Stop 1 plus successor lean plus unpublished path-1 that cites only
 * the lean. Refuse the path-1 write on any published pain-coverage reason.
 * Skip the ingest-ready remaining-set write when that write is refused.
 * Live-thread evaluateCompletedArcRecord is missing-record and is not this gate.
 */

import {
  type CompletedArcBlockReason,
  type CompletedArcVerdict,
  evaluateCompletedArcRecord,
  isSuccessorLeanBody,
  type ThreadComment,
} from "./completed-arc-record.js";

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

/** Unpublished path-1 body that cites only the successor lean. No table id. */
export function leanCiteOnlyPath1Body(successorLeanId: number): string {
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
};

export type AutoStampPath1WriteVerdict = {
  readonly writePath1: boolean;
  readonly writeIngestReadyRemainingSet: boolean;
  readonly unpublished: ThreadComment | null;
  readonly candidate: CompletedArcVerdict;
};

function refuse(
  unpublished: ThreadComment | null,
  candidate: CompletedArcVerdict,
): AutoStampPath1WriteVerdict {
  return {
    writePath1: false,
    writeIngestReadyRemainingSet: false,
    unpublished,
    candidate,
  };
}

/**
 * Production caller for #3640 auto-stamp path-1.
 *
 * Parent calls this before any path-1 write. Constructs the dest candidate
 * (lean citation only). Refuses both the path-1 write and the ingest-ready
 * remaining-set write when that candidate is not complete. Chip ingest-ready
 * only when that unpublished candidate is complete. Live-thread
 * evaluateCompletedArcRecord is missing-record and is not this gate. English
 * Pain-audit headings are not targeting; criticEnvelopes reads the closed
 * audit-targets field. Does not grow resolveAutoStampCatalogChip. Does not
 * treat operatorVerbApplySet autoStamp as this write (#4648).
 */
export function evaluateAutoStampPath1Write(
  input: AutoStampPath1WriteInput,
): AutoStampPath1WriteVerdict {
  const lean = latestSuccessorLeanComment(input.comments);
  if (lean === undefined) {
    return refuse(
      null,
      evaluateCompletedArcRecord({
        comments: input.comments,
        issueNumber: input.issueNumber,
      }),
    );
  }
  const fallbackId = nextUnpublishedCommentId(input.comments, lean.id);
  const unpublishedId =
    input.unpublishedCommentId !== undefined && input.unpublishedCommentId > lean.id
      ? input.unpublishedCommentId
      : fallbackId;
  const unpublished: ThreadComment = {
    id: unpublishedId,
    body: leanCiteOnlyPath1Body(lean.id),
  };
  const candidate = evaluateCompletedArcRecord({
    comments: [...input.comments, unpublished],
    issueNumber: input.issueNumber,
  });
  if (candidate.status === "complete") {
    return {
      writePath1: true,
      writeIngestReadyRemainingSet: true,
      unpublished,
      candidate,
    };
  }
  return refuse(unpublished, candidate);
}
