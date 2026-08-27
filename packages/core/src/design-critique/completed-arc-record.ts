/**
 * Completed-arc record for design-critique ingest (#3806).
 *
 * Catalog chips are list-visible convenience, not clearance. Ingest waits on
 * `design-critique: synthesis accepted, because ...` citing an accepted
 * successor lean (and the verified-claims table when that comment exists).
 */

import { DESIGN_CRITIQUE_CATALOG_CHIPS } from "./exclusive-chip.js";

export type ThreadComment = {
  readonly id: number;
  readonly body: string;
};

export type CompletedArcBlockReason =
  | "missing-record"
  | "lone-shape"
  | "cite-not-lean"
  | "missing-table-cite";

export type CompletedArcVerdict =
  | { readonly status: "not-in-arc" }
  | {
      readonly status: "complete";
      readonly synthesisCommentId: number;
      readonly citedLeanId: number;
      readonly citedTableId: number | null;
    }
  | {
      readonly status: "blocked";
      readonly reason: CompletedArcBlockReason;
      readonly detail: string;
    };

const SYNTHESIS_SHAPE_RE = /(?:^|\n)\s*design-critique:\s*synthesis accepted,\s*because\b/i;
const LEAN_HEADING_RE = /(?:^|\n)\s*\*{0,2}Lean:\*{0,2}/;
const TABLE_HEADING_RE = /(?:^|\n)\s*##\s+Verified-claims table\b/;
const CITE_RE =
  /\b(?:successor\s+lean|lean|verified-claims table|comment)\s*:?\s+(\d{8,})\b|#issuecomment-(\d{8,})|\/issues\/comments\/(\d{8,})/gi;

const CATALOG = new Set<string>(DESIGN_CRITIQUE_CATALOG_CHIPS);

export class DesignCritiqueIngestBlockedError extends Error {
  readonly issueNumber: number;
  readonly reason: CompletedArcBlockReason;

  constructor(issueNumber: number, reason: CompletedArcBlockReason, detail: string) {
    super(
      `issue:ingest refused #${issueNumber}: design-critique ${reason} (${detail}) -- nothing written.`,
    );
    this.name = "DesignCritiqueIngestBlockedError";
    this.issueNumber = issueNumber;
    this.reason = reason;
  }
}

export function isSynthesisAcceptedShape(body: string): boolean {
  return SYNTHESIS_SHAPE_RE.test(body);
}

export function isSuccessorLeanBody(body: string): boolean {
  return LEAN_HEADING_RE.test(body);
}

export function isVerifiedClaimsTableBody(body: string): boolean {
  return TABLE_HEADING_RE.test(body);
}

export function extractCitedCommentIds(body: string): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  const re = new RegExp(CITE_RE.source, CITE_RE.flags);
  for (const match of body.matchAll(re)) {
    const raw = match[1] ?? match[2] ?? match[3];
    if (raw === undefined) continue;
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function hasDesignCritiqueCatalogChip(labels: readonly string[]): boolean {
  return labels.some((name) => CATALOG.has(name));
}

const CRITIC_ROLE_RE = /(?:^|\n)\s*role:\s*critic\b/i;
const MECHANISM_SHAPED_FIELD_RE = /(?:^|\n)\s*mechanism-shaped:\s*true\b/i;
const PANEL_DEPOSIT_RE = /(?:^|\n)\s*panel-deposit\b/i;
const PARENT_ROLE_RE = /(?:^|\n)\s*role:\s*parent\b/i;
const SIBLINGS_FIELD_RE = /(?:^|\n)\s*siblings:\s*\d+/i;
const INPUT_CEILING_FIELD_RE = /(?:^|\n)\s*input-ceiling:\s*\d+/i;

export function isPanelDepositBody(body: string): boolean {
  if (PANEL_DEPOSIT_RE.test(body)) return true;
  return (
    PARENT_ROLE_RE.test(body) && SIBLINGS_FIELD_RE.test(body) && INPUT_CEILING_FIELD_RE.test(body)
  );
}

export function isInFlightCritiqueThread(comments: readonly ThreadComment[]): boolean {
  return comments.some(
    (comment) =>
      isSuccessorLeanBody(comment.body) ||
      CRITIC_ROLE_RE.test(comment.body) ||
      MECHANISM_SHAPED_FIELD_RE.test(comment.body) ||
      isPanelDepositBody(comment.body),
  );
}

function byId(comments: readonly ThreadComment[]): Map<number, ThreadComment> {
  const map = new Map<number, ThreadComment>();
  for (const comment of comments) {
    map.set(comment.id, comment);
  }
  return map;
}

function latestSuccessorLean(comments: readonly ThreadComment[]): ThreadComment | undefined {
  let latest: ThreadComment | undefined;
  for (const comment of comments) {
    if (!isSuccessorLeanBody(comment.body)) continue;
    if (latest === undefined || comment.id > latest.id) latest = comment;
  }
  return latest;
}

function verdictForSynthesis(
  comment: ThreadComment,
  comments: readonly ThreadComment[],
): CompletedArcVerdict {
  const cited = extractCitedCommentIds(comment.body);
  if (cited.length === 0) {
    return {
      status: "blocked",
      reason: "lone-shape",
      detail:
        "synthesis-accepted sentence shape is present but does not cite an accepted successor lean",
    };
  }
  const byCommentId = byId(comments);
  const citedLean = cited
    .map((id) => byCommentId.get(id))
    .find((row) => row !== undefined && isSuccessorLeanBody(row.body));
  if (citedLean === undefined) {
    return {
      status: "blocked",
      reason: "cite-not-lean",
      detail: "cited id is not a successor lean on this thread",
    };
  }
  const citedTable = cited
    .map((id) => byCommentId.get(id))
    .find((row) => row !== undefined && isVerifiedClaimsTableBody(row.body));
  if (citedTable === undefined) {
    const claimedTable = /\bverified-claims table\s+\d{8,}\b/i.test(comment.body);
    if (claimedTable) {
      return {
        status: "blocked",
        reason: "missing-table-cite",
        detail: "synthesis cites a verified-claims table id that is not a table on this thread",
      };
    }
  }
  return {
    status: "complete",
    synthesisCommentId: comment.id,
    citedLeanId: citedLean.id,
    citedTableId: citedTable?.id ?? null,
  };
}

/**
 * Ingest clearance from thread structure. Labels and author identity are not
 * predicates. A lone synthesis-accepted sentence shape is not the record.
 * Clearance cites the latest successor lean; an older complete record does not
 * clear a later recut. A panel-deposit is in-flight even before critic posts.
 */
export function evaluateCompletedArcRecord(input: {
  readonly labels?: readonly string[];
  readonly comments: readonly ThreadComment[];
}): CompletedArcVerdict {
  const comments = input.comments;
  const labels = input.labels ?? [];
  const synthesis = comments.filter((c) => isSynthesisAcceptedShape(c.body));
  const completeRecords = synthesis
    .map((comment) => verdictForSynthesis(comment, comments))
    .filter((verdict): verdict is Extract<CompletedArcVerdict, { status: "complete" }> => {
      return verdict.status === "complete";
    });
  if (completeRecords.length > 0) {
    const latestLean = latestSuccessorLean(comments);
    const matching =
      latestLean === undefined
        ? completeRecords
        : completeRecords.filter((record) => record.citedLeanId === latestLean.id);
    if (matching.length > 0) {
      return matching.reduce((a, b) => (a.synthesisCommentId >= b.synthesisCommentId ? a : b));
    }
    const latestCompleteId = completeRecords.reduce(
      (max, record) => Math.max(max, record.synthesisCommentId),
      0,
    );
    const laterSynthesis = synthesis.filter((comment) => comment.id > latestCompleteId);
    if (laterSynthesis.length > 0) {
      const latest = laterSynthesis.reduce((a, b) => (a.id >= b.id ? a : b));
      return verdictForSynthesis(latest, comments);
    }
    return {
      status: "blocked",
      reason: "missing-record",
      detail:
        "a later successor lean recut the arc; ingest waits on a completed-arc record citing that latest lean",
    };
  }
  if (synthesis.length > 0) {
    const latest = synthesis.reduce((a, b) => (a.id >= b.id ? a : b));
    return verdictForSynthesis(latest, comments);
  }
  const inArc = hasDesignCritiqueCatalogChip(labels) || isInFlightCritiqueThread(comments);
  if (!inArc) {
    return { status: "not-in-arc" };
  }
  return {
    status: "blocked",
    reason: "missing-record",
    detail:
      "design-critique is in flight but the completed-arc record is missing: " +
      "`design-critique: synthesis accepted, because ...` citing the accepted successor lean",
  };
}

export function assertCompletedArcAllowsIngest(input: {
  readonly issueNumber: number;
  readonly labels?: readonly string[];
  readonly comments: readonly ThreadComment[];
}): CompletedArcVerdict {
  const verdict = evaluateCompletedArcRecord(input);
  if (verdict.status === "blocked") {
    throw new DesignCritiqueIngestBlockedError(input.issueNumber, verdict.reason, verdict.detail);
  }
  return verdict;
}
