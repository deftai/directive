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

function byId(comments: readonly ThreadComment[]): Map<number, ThreadComment> {
  const map = new Map<number, ThreadComment>();
  for (const comment of comments) {
    map.set(comment.id, comment);
  }
  return map;
}

/**
 * Ingest clearance from thread structure. Labels and author identity are not
 * predicates. A lone synthesis-accepted sentence shape is not the record.
 */
export function evaluateCompletedArcRecord(input: {
  readonly labels?: readonly string[];
  readonly comments: readonly ThreadComment[];
}): CompletedArcVerdict {
  const comments = input.comments;
  const labels = input.labels ?? [];
  const synthesis = comments.filter((c) => isSynthesisAcceptedShape(c.body));
  const inArc = synthesis.length > 0 || hasDesignCritiqueCatalogChip(labels);

  if (!inArc) {
    return { status: "not-in-arc" };
  }
  if (synthesis.length === 0) {
    return {
      status: "blocked",
      reason: "missing-record",
      detail:
        "catalog chip is present but the completed-arc record is missing: " +
        "`design-critique: synthesis accepted, because ...` citing the accepted successor lean",
    };
  }

  const latest = synthesis.reduce((a, b) => (a.id >= b.id ? a : b));
  const cited = extractCitedCommentIds(latest.body);
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
    .find((comment) => comment !== undefined && isSuccessorLeanBody(comment.body));
  if (citedLean === undefined) {
    return {
      status: "blocked",
      reason: "cite-not-lean",
      detail: "cited id is not a successor lean on this thread",
    };
  }

  const tables = comments.filter((c) => isVerifiedClaimsTableBody(c.body));
  let citedTableId: number | null = null;
  if (tables.length > 0) {
    const citedTable = cited
      .map((id) => byCommentId.get(id))
      .find((comment) => comment !== undefined && isVerifiedClaimsTableBody(comment.body));
    if (citedTable === undefined) {
      return {
        status: "blocked",
        reason: "missing-table-cite",
        detail:
          "verified-claims table was posted but the synthesis-accepted record does not cite it",
      };
    }
    citedTableId = citedTable.id;
  }

  return {
    status: "complete",
    synthesisCommentId: latest.id,
    citedLeanId: citedLean.id,
    citedTableId,
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
