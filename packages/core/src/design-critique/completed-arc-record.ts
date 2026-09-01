/**
 * Completed-arc record for design-critique ingest (#3806).
 *
 * Catalog chips are list-visible convenience, not clearance. Ingest waits on
 * `design-critique: synthesis accepted, because ...` citing an accepted
 * successor lean (and the verified-claims table when that comment exists).
 *
 * Citations are parsed once, by `scanCitations` (#3831). The accepted forms and
 * the refused positions are published in `content/contracts/design-critique.md`
 * `## Citation grammar`. Clearance is set membership against the latest
 * successor lean, not position in the body, so citing the superseded lean --
 * which `## Successor lean` requires -- cannot block.
 *
 * Set-level bind (#4057) does not change that mapper. Un-recut members refuse
 * on `cancelled` or `unrecut-body`. Parent dominate prose is not a record.
 * A later successor lean after cancel starts a recut arc.
 */

import {
  ACCEPTED_CITATION_FORMS,
  type Citation,
  type CitationScan,
  classifyPosition,
  scanCitations,
} from "./citation-grammar.js";
import { DESIGN_CRITIQUE_CATALOG_CHIPS } from "./exclusive-chip.js";

export type ThreadComment = {
  readonly id: number;
  readonly body: string;
};

/**
 * Closed reason set, published in `content/contracts/design-critique.md`
 * `### One parser, set membership, observed diagnostics`. The union is derived
 * from this array so a member added here without a contract row fails the
 * content-contract suite (#3942).
 */
export const COMPLETED_ARC_BLOCK_REASONS = [
  "missing-record",
  "lone-shape",
  "cite-not-lean",
  "missing-table-cite",
  "unshaped-table-cite",
  "ambiguous-table-cite",
  "cancelled",
  "unrecut-body",
] as const;

export type CompletedArcBlockReason = (typeof COMPLETED_ARC_BLOCK_REASONS)[number];

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
const CANCELLED_SHAPE_RE = /(?:^|\n)\s*design-critique:\s*cancelled,\s*because\b/i;
const TARGET_SHAPE_FIELD_RE = /(?:^|\n)\s*target shape:\s*([^\n]+)/gi;
const LEAN_HEADING_RE = /(?:^|\n)\s*\*{0,2}Lean:\*{0,2}/;
const TABLE_HEADING_RE = /(?:^|\n)\s*##\s+Verified-claims table\b/;

/** How many ids a block detail lists before it truncates. */
const DETAIL_ID_LIMIT = 5;

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

export function isCancelledShape(body: string): boolean {
  return CANCELLED_SHAPE_RE.test(body);
}

export function isSuccessorLeanBody(body: string): boolean {
  return LEAN_HEADING_RE.test(body);
}

export function isVerifiedClaimsTableBody(body: string): boolean {
  return TABLE_HEADING_RE.test(body);
}

/**
 * Ids cited by one comment body, in document order. Thin projection of the
 * shared parser -- the grammar itself lives in `citation-grammar.ts`.
 */
export function extractCitedCommentIds(body: string): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const citation of scanCitations(body).citations) {
    if (seen.has(citation.id)) continue;
    seen.add(citation.id);
    ids.push(citation.id);
  }
  return ids;
}

export function hasDesignCritiqueCatalogChip(labels: readonly string[]): boolean {
  return labels.some((name) => CATALOG.has(name));
}

const CRITIC_ROLE_RE = /(?:^|\n)\s*role:\s*critic\b/i;
const TRIAGE_ROLE_RE = /(?:^|\n)\s*role:\s*triage\b/i;
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

function isParentOrTriageAuthority(body: string): boolean {
  return PARENT_ROLE_RE.test(body) || TRIAGE_ROLE_RE.test(body);
}

function hasOperativeCancelledShape(body: string): boolean {
  const re = new RegExp(CANCELLED_SHAPE_RE.source, "gi");
  for (const match of body.matchAll(re)) {
    const matchOffset = match.index ?? 0;
    const inner = match[0].search(/design-critique:/i);
    const offset = matchOffset + (inner >= 0 ? inner : 0);
    if (classifyPosition(body, offset) === null) return true;
  }
  return false;
}

function latestCancelled(comments: readonly ThreadComment[]): ThreadComment | undefined {
  let latest: ThreadComment | undefined;
  for (const comment of comments) {
    if (!isParentOrTriageAuthority(comment.body)) continue;
    if (!hasOperativeCancelledShape(comment.body)) continue;
    if (latest === undefined || comment.id > latest.id) latest = comment;
  }
  return latest;
}

function latestTargetShapeIsSetLevel(comments: readonly ThreadComment[]): boolean {
  let latest: { readonly id: number; readonly setLevel: boolean } | undefined;
  for (const comment of comments) {
    if (!isParentOrTriageAuthority(comment.body)) continue;
    TARGET_SHAPE_FIELD_RE.lastIndex = 0;
    for (const match of comment.body.matchAll(TARGET_SHAPE_FIELD_RE)) {
      const offset = match.index ?? 0;
      if (classifyPosition(comment.body, offset) !== null) continue;
      const value = (match[1] ?? "").trim().toLowerCase();
      const setLevel = value.startsWith("set-level");
      if (latest === undefined || comment.id >= latest.id) {
        latest = { id: comment.id, setLevel };
      }
    }
  }
  return latest?.setLevel === true;
}

function refuseUnrecutSetLevel(
  comments: readonly ThreadComment[],
  verdict: CompletedArcVerdict,
): CompletedArcVerdict {
  if (verdict.status !== "complete" || !latestTargetShapeIsSetLevel(comments)) {
    return verdict;
  }
  return {
    status: "blocked",
    reason: "unrecut-body",
    detail:
      "completed-arc record is present but the latest target shape is set-level; " +
      "ingest waits on a recut body or a newly filed issue (comment id " +
      String(verdict.synthesisCommentId) +
      ")",
  };
}

function renderIds(ids: readonly number[]): string {
  const shown = ids.slice(0, DETAIL_ID_LIMIT).join(", ");
  return ids.length > DETAIL_ID_LIMIT
    ? `${shown}, and ${ids.length - DETAIL_ID_LIMIT} more`
    : shown;
}

/**
 * Report what was scanned and what was found. A guess at the cause sends the
 * operator back to re-post the same body and reproduce the block (#3831).
 */
function loneShapeDetail(scan: CitationScan): string {
  const parts = [
    "synthesis-accepted sentence shape is present but cites no accepted successor lean",
  ];
  if (scan.idShapedRuns.length === 0) {
    parts.push("no 8-or-more digit id appears in the body");
  } else {
    parts.push(
      `${scan.idShapedRuns.length} 8-or-more digit id(s) appear in the body: ` +
        renderIds(scan.idShapedRuns),
    );
  }
  if (scan.rejected.length > 0) {
    const classes = [...new Set(scan.rejected.map((row) => row.reason))].sort().join(", ");
    parts.push(
      `${scan.rejected.length} keyword-anchored occurrence(s) refused by position (${classes})`,
    );
  }
  parts.push(`accepted forms: ${ACCEPTED_CITATION_FORMS.join(" | ")}`);
  return parts.join("; ");
}

function resolveCitedLean(
  citations: readonly Citation[],
  byCommentId: Map<number, ThreadComment>,
  latestLean: ThreadComment | undefined,
): ThreadComment | undefined {
  if (latestLean !== undefined && citations.some((row) => row.id === latestLean.id)) {
    return latestLean;
  }
  return citations
    .map((row) => byCommentId.get(row.id))
    .find((row) => row !== undefined && isSuccessorLeanBody(row.body));
}

type TableResolution =
  | { readonly ok: true; readonly table: ThreadComment | undefined }
  | { readonly ok: false; readonly reason: CompletedArcBlockReason; readonly detail: string };

/**
 * Table resolution precedence (#3932).
 *
 * A typed `verified-claims table <id>` citation is the synthesis naming its own
 * table, so it decides resolution: a generic citation neither satisfies it nor
 * masks it. Scanning every citation for the first table-shaped body -- what
 * this did before -- let an unrelated table-shaped comment clear a record whose
 * claimed table is not a table, because the `missing-table-cite` refusal ran
 * only after that untyped search failed.
 *
 * Cardinality rule: every table-kind claim must resolve to the same
 * verified-claims table artifact. One valid typed claim must not launder an
 * invalid one -- filtering to typed citations and then taking the first
 * table-shaped body finds the real table in a valid-plus-ghost pair and never
 * examines the ghost. `scanCitations` deduplicates on `(id, kind)`, so naming
 * one table id twice is a single claim, while two distinct typed ids are two
 * claims and cannot both be this record's table.
 *
 * With no typed claim the generic scan stands unchanged: permalink and bare
 * `comment` citations scan as kind `comment`, and that is the published form
 * these records use. Narrowing the citation contract so a table must be named
 * by keyword is a separate decision needing its own migration criteria.
 *
 * Refusal partition (#3942). A typed claim fails in two states, and only one of
 * them is fixed by adding the heading: the id is not a comment on this thread,
 * or it is a comment whose body fails `isVerifiedClaimsTableBody`. One reason
 * and one detail for both asserted the first in either case, so an author whose
 * table is on the thread read a true citation being called false and had no
 * path to the missing heading. Absent ids rank first because a body that is not
 * there cannot be given a heading.
 */
function resolveCitedTable(
  citations: readonly Citation[],
  byCommentId: Map<number, ThreadComment>,
): TableResolution {
  const claimed = citations.filter((row) => row.kind === "table");
  if (claimed.length === 0) {
    return {
      ok: true,
      table: citations
        .map((row) => byCommentId.get(row.id))
        .find((row) => row !== undefined && isVerifiedClaimsTableBody(row.body)),
    };
  }
  const resolved = claimed.map((row) => ({ id: row.id, cited: byCommentId.get(row.id) }));
  const absent = resolved.filter((row) => row.cited === undefined).map((row) => row.id);
  const unshaped = resolved
    .filter((row) => row.cited !== undefined && !isVerifiedClaimsTableBody(row.cited.body))
    .map((row) => row.id);
  if (absent.length > 0) {
    return {
      ok: false,
      reason: "missing-table-cite",
      detail:
        "synthesis cites a verified-claims table id that is not a comment on this thread: " +
        renderIds(absent) +
        (unshaped.length > 0
          ? "; also cited, on this thread and carrying no verified-claims-table heading: " +
            renderIds(unshaped)
          : ""),
    };
  }
  if (unshaped.length > 0) {
    return {
      ok: false,
      reason: "unshaped-table-cite",
      detail:
        "synthesis cites a verified-claims table id that is a comment on this thread but " +
        "opens no line with the `## Verified-claims table` heading: " +
        renderIds(unshaped) +
        "; add that heading to the cited comment",
    };
  }
  const distinct = [...new Set(claimed.map((row) => row.id))];
  if (distinct.length > 1) {
    return {
      ok: false,
      reason: "ambiguous-table-cite",
      detail:
        "synthesis claims more than one verified-claims table; every table citation must name " +
        "the same table: " +
        renderIds(distinct),
    };
  }
  return { ok: true, table: resolved.find((row) => row.cited !== undefined)?.cited };
}

function verdictForSynthesis(
  comment: ThreadComment,
  comments: readonly ThreadComment[],
): CompletedArcVerdict {
  const scan = scanCitations(comment.body);
  const citations = scan.citations;
  if (citations.length === 0) {
    return {
      status: "blocked",
      reason: "lone-shape",
      detail: loneShapeDetail(scan),
    };
  }
  const byCommentId = byId(comments);
  const citedLean = resolveCitedLean(citations, byCommentId, latestSuccessorLean(comments));
  if (citedLean === undefined) {
    return {
      status: "blocked",
      reason: "cite-not-lean",
      detail:
        "no cited id is a successor lean on this thread; cited: " +
        renderIds(citations.map((row) => row.id)),
    };
  }
  const citedTable = resolveCitedTable(citations, byCommentId);
  if (!citedTable.ok) {
    return { status: "blocked", reason: citedTable.reason, detail: citedTable.detail };
  }
  return {
    status: "complete",
    synthesisCommentId: comment.id,
    citedLeanId: citedLean.id,
    citedTableId: citedTable.table?.id ?? null,
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
  const cancel = latestCancelled(comments);
  const latestLeanForCancel = latestSuccessorLean(comments);
  if (
    cancel !== undefined &&
    (latestLeanForCancel === undefined || latestLeanForCancel.id < cancel.id)
  ) {
    return {
      status: "blocked",
      reason: "cancelled",
      detail:
        "design-critique: cancelled, because ... on comment " +
        String(cancel.id) +
        "; this number is not a harvest story. Recut the body or file a new issue. " +
        "A later successor lean after this cancel starts a new arc",
    };
  }
  const recutComments =
    cancel === undefined ? comments : comments.filter((comment) => comment.id > cancel.id);
  const synthesis = recutComments.filter((c) => isSynthesisAcceptedShape(c.body));
  const completeRecords = synthesis
    .map((comment) => verdictForSynthesis(comment, recutComments))
    .filter((verdict): verdict is Extract<CompletedArcVerdict, { status: "complete" }> => {
      return verdict.status === "complete";
    });
  if (completeRecords.length > 0) {
    const latestLean = latestSuccessorLean(recutComments);
    const matching =
      latestLean === undefined
        ? completeRecords
        : completeRecords.filter((record) => record.citedLeanId === latestLean.id);
    if (matching.length > 0) {
      return refuseUnrecutSetLevel(
        recutComments,
        matching.reduce((a, b) => (a.synthesisCommentId >= b.synthesisCommentId ? a : b)),
      );
    }
    const latestCompleteId = completeRecords.reduce(
      (max, record) => Math.max(max, record.synthesisCommentId),
      0,
    );
    const laterSynthesis = synthesis.filter((comment) => comment.id > latestCompleteId);
    if (laterSynthesis.length > 0) {
      const latest = laterSynthesis.reduce((a, b) => (a.id >= b.id ? a : b));
      return refuseUnrecutSetLevel(recutComments, verdictForSynthesis(latest, recutComments));
    }
    const citedLeanIds = completeRecords.map((record) => record.citedLeanId);
    const latestLeanId = latestLean === undefined ? "unknown" : String(latestLean.id);
    return {
      status: "blocked",
      reason: "missing-record",
      detail:
        `no completed-arc record cites the latest successor lean ${latestLeanId} on this thread; ` +
        `existing record(s) cite lean ${renderIds(citedLeanIds)}; ` +
        `ingest waits on a record citing lean ${latestLeanId}`,
    };
  }
  if (synthesis.length > 0) {
    const latest = synthesis.reduce((a, b) => (a.id >= b.id ? a : b));
    return refuseUnrecutSetLevel(recutComments, verdictForSynthesis(latest, recutComments));
  }
  const inArc = hasDesignCritiqueCatalogChip(labels) || isInFlightCritiqueThread(recutComments);
  if (!inArc) {
    return { status: "not-in-arc" };
  }
  return {
    status: "blocked",
    reason: "missing-record",
    detail:
      "design-critique is in flight but the completed-arc record is missing: " +
      "`design-critique: synthesis accepted, because ...` citing the accepted successor lean; " +
      `accepted forms: ${ACCEPTED_CITATION_FORMS.join(" | ")}`,
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
