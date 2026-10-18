/**
 * Lean-cite-only candidate-record gate for #3640 auto-stamp path-1 (#4592).
 *
 * Dest is Stop 1 plus successor lean plus unpublished path-1 that cites only
 * the lean. Refuse the path-1 write on any published pain-coverage reason.
 * Skip the ingest-ready remaining-set write when that write is refused.
 * Live-thread evaluateCompletedArcRecord is missing-record and is not this gate.
 * Parent must supply a non-empty plain-English summary for the unpublished body (#5415).
 */

import { matchAny } from "../orchestration/pathspec.js";
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

// ---------------------------------------------------------------------------
// #5486 Remint-3 P1 write-posture + P3 gate consumer
// ---------------------------------------------------------------------------

/**
 * P1 write-posture pick-one (tracked-vs-working-directory reading of in-tree):
 * (i) critics zero in-tree writes + parent collects (chosen), or
 * (ii) Run posture third action + allowlist under working-directory in-tree.
 * Branch (ii) deleted as unused; parent-collect matches exclusive-create outboxes.
 */
export const CRITIC_WRITE_POSTURES = ["parent-collect", "run-posture-allowlist"] as const;
export type CriticWritePosture = (typeof CRITIC_WRITE_POSTURES)[number];
export const CHOSEN_CRITIC_WRITE_POSTURE: CriticWritePosture = "parent-collect";

export type NoIssueGateAdmissionInput = {
  readonly targetId: string;
  readonly targetKind: "issue" | "xbrief" | "envelope-file";
  /** Authoritative marker (brief/sidecar field), not a fake GitHub label. */
  readonly authoritativeMarker: string;
  readonly completedArc: CompletedArcVerdict;
  readonly liveRevisionDigest: string;
  readonly pinnedTargetDigest: string | null;
  /**
   * Adapter over GATE_MATCH_PREDICATES: for no-issue targets, `paths` matches
   * target path identity and `body-text` matches the authoritative marker.
   * Labels/state/age-days stay GitHub-issue path.
   */
  readonly match: Readonly<Record<string, unknown>>;
};

export type NoIssueGateAdmission =
  | { readonly ok: true; readonly entryPoint: "evaluateNoIssueGateAdmission" }
  | {
      readonly ok: false;
      readonly reason:
        | "missing-marker"
        | "incomplete-arc"
        | "stale-revision"
        | "unrecognised-predicate"
        | "predicate-mismatch"
        | "storage-only";
      readonly detail: string;
      readonly recovery: "discovery" | "manual-diagnosis";
    };

/** No-issue path admits only paths + body-text; labels/state/age-days stay issue-path. */
const NO_ISSUE_GATE_PREDICATES = new Set(["body-text", "paths"]);

function anyOfStrings(value: unknown): string[] | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const anyOf = (value as Record<string, unknown>)["any-of"];
  if (!Array.isArray(anyOf) || anyOf.length === 0) return null;
  if (!anyOf.every((entry) => typeof entry === "string")) return null;
  return anyOf as string[];
}

/**
 * P3 gate consumer: named admission entry point consuming target identity,
 * authoritative marker, completed-arc proof, and live revision via adapter
 * over GATE_MATCH_PREDICATES. Storage fields alone are insufficient. No fake
 * GitHub labels. Predicate *values* must match targetId / authoritativeMarker.
 */
export function evaluateNoIssueGateAdmission(
  input: NoIssueGateAdmissionInput,
): NoIssueGateAdmission {
  if (input.authoritativeMarker.trim().length === 0) {
    return {
      ok: false,
      reason: "missing-marker",
      detail: "authoritative marker required; do not invent non-catalog GitHub labels",
      recovery: "manual-diagnosis",
    };
  }
  if (input.completedArc.status !== "complete") {
    return {
      ok: false,
      reason: "incomplete-arc",
      detail: `completed-arc proof required; status=${input.completedArc.status}`,
      recovery: "discovery",
    };
  }
  if (input.pinnedTargetDigest !== null && input.liveRevisionDigest !== input.pinnedTargetDigest) {
    return {
      ok: false,
      reason: "stale-revision",
      detail: `live revision sha256:${input.liveRevisionDigest} != pinned sha256:${input.pinnedTargetDigest}`,
      recovery: "discovery",
    };
  }

  const keys = Object.keys(input.match);
  if (keys.length === 0) {
    return {
      ok: false,
      reason: "storage-only",
      detail: "storage fields alone insufficient; require GATE_MATCH_PREDICATES adapter keys",
      recovery: "manual-diagnosis",
    };
  }
  const extra = keys.filter((k) => !NO_ISSUE_GATE_PREDICATES.has(k));
  if (extra.length > 0) {
    return {
      ok: false,
      reason: "unrecognised-predicate",
      detail: `unrecognised or unsupported no-issue predicate(s) ${JSON.stringify(extra)}; expected ${[...NO_ISSUE_GATE_PREDICATES].sort().join(", ")} (labels/state/age-days are issue-path only)`,
      recovery: "manual-diagnosis",
    };
  }

  if ("paths" in input.match) {
    const paths = anyOfStrings(input.match.paths);
    if (paths === null) {
      return {
        ok: false,
        reason: "predicate-mismatch",
        detail: "paths requires non-empty any-of string list",
        recovery: "manual-diagnosis",
      };
    }
    // Reuse GATE_MATCH_PREDICATES path globs (exact path or ** glob).
    if (!matchAny(paths, input.targetId)) {
      return {
        ok: false,
        reason: "predicate-mismatch",
        detail: `paths.any-of does not match targetId ${input.targetId}`,
        recovery: "manual-diagnosis",
      };
    }
  }

  if ("body-text" in input.match) {
    const markers = anyOfStrings(input.match["body-text"]);
    if (markers === null) {
      return {
        ok: false,
        reason: "predicate-mismatch",
        detail: "body-text requires non-empty any-of string list",
        recovery: "manual-diagnosis",
      };
    }
    // Reuse GATE_MATCH_PREDICATES body-text: case-insensitive substring.
    const markerLower = input.authoritativeMarker.toLowerCase();
    if (
      !markers.some((needle) => needle.length > 0 && markerLower.includes(needle.toLowerCase()))
    ) {
      return {
        ok: false,
        reason: "predicate-mismatch",
        detail: "body-text.any-of does not case-insensitively match authoritativeMarker",
        recovery: "manual-diagnosis",
      };
    }
  }

  return { ok: true, entryPoint: "evaluateNoIssueGateAdmission" };
}
