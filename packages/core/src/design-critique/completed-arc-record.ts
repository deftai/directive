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
 * Set-level bind (#4057) does not change that mapper. Dominated members refuse
 * on `cancelled` or `set-level-body`. Parent dominate prose is not a record.
 * A later successor lean after cancel starts a later arc.
 */

import { createHash } from "node:crypto";
import type { LabelClient } from "../vbrief-reconcile/types.js";
import {
  ACCEPTED_CITATION_FORMS,
  ACCEPTED_PAIN_CITE_FORMS,
  ACCEPTED_PAIN_LIST_FORMS,
  type Citation,
  type CitationScan,
  classifyPosition,
  scanCitations,
  scanPainCites,
  scanPainList,
} from "./citation-grammar.js";
import {
  DESIGN_CRITIQUE_CATALOG_CHIPS,
  writeDesignCritiqueCatalogRemainingSet,
} from "./exclusive-chip.js";
import { evaluateAccumulatedPainAuditFollowThrough } from "./pain-audit-follow-through-gate.js";
import {
  type AuditEnvelope,
  buildPainCoverageDeposit,
  evaluateParentAudit,
  extractOperativeAuditTargets,
} from "./parent-audit.js";

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
  "set-level-body",
  "stale-target",
  "missing-pain",
  "malformed-pain",
  "unrelieved-pain",
  "unresolved-pain-audit",
  "later-arc-in-flight",
  "missing-plain-english",
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
/** Closed LGTM / move-forward lead (#5488). Distinct from the classic `because` form. */
const MOVE_FORWARD_SYNTHESIS_SHAPE_RE =
  /(?:^|\n)\s*design-critique:\s*synthesis accepted,\s*move-forward\s+yes,\s*material-findings\s+none\b/i;
const CANCELLED_SHAPE_RE = /(?:^|\n)\s*design-critique:\s*cancelled,\s*because\b/i;
const MATERIALITY_BAR_FIELD_RE = /(?:^|\n)[ \t]*materiality-bar:[ \t]*(ship-ready|open)\b/gi;
const MOVE_FORWARD_FIELD_RE = /(?:^|\n)[ \t]*move-forward:[ \t]*yes\b/gi;
const CLEAN_RESULT_FIELD_RE = /(?:^|\n)[ \t]*clean-result:[ \t]*yes\b/gi;
/** Line-start dispatch-fail; fences / quotes do not count (#5488 Greptile P1). */
const DISPATCH_FAIL_FIELD_RE = /(?:^|\n)[ \t]*dispatch-fail(?:ure)?\b/gi;
/** Operative finding class lines / headings — not prose mentions (#5488 Greptile P1). */
const OPERATIVE_FINDING_CLASS_RE =
  /(?:^|\n)\s*(?:#{1,6}\s*)?(blocks-the-design|sharpens-framing|footnote)\s*:/gi;
/** Closed promote marker for ship-ready sharpen readiness obligations. */
const PROMOTED_SHARPEN_RE = /(?:^|\n)\s*promoted:\s*yes\b/i;

/** Closed completed-arc lead for ship-ready LGTM completion (#5488). */
export const MOVE_FORWARD_SYNTHESIS_LEAD =
  "design-critique: synthesis accepted, move-forward yes, material-findings none";

export const MATERIALITY_BAR_FIELD = "materiality-bar:";

export type MaterialityBar = "ship-ready" | "open";

export type MaterialityBarSource = "ship-ready" | "lgtm" | "default";

export type MaterialityBarParse =
  | {
      readonly kind: "resolved";
      readonly bar: MaterialityBar;
      readonly source: MaterialityBarSource;
    }
  | { readonly kind: "ask"; readonly reason: "ambiguous" };

/** Closed launch tokens that resolve to ship-ready. Word boundaries. */
const SHIP_READY_TOKEN_RE = /\bship-ready\b/i;
const LGTM_TOKEN_RE = /\blgtm\b/i;

export type LgtmSeatCensus =
  | "clean-result"
  | "footnote-only"
  | "stub"
  | "blank"
  | "dispatch-fail"
  | "blocking-present"
  | "sharpening-present";

export type LgtmConjunctRefuseReason =
  | "ship-ready-required"
  | "blocker-present"
  | "unresolved-blocker"
  | "missing-move-forward"
  | "stub-or-blank"
  | "dispatch-fail"
  | "yolo-alone";

export type LgtmConjunctInput = {
  readonly materialityBar: MaterialityBar;
  readonly acceptedBlockerCount: number;
  readonly unresolvedBlockerResidualCount: number;
  readonly parentMoveForwardRecorded: boolean;
  readonly seatCensus: readonly LgtmSeatCensus[];
  /** Yolo standing alone never satisfies move-forward (#5488 limb 6). */
  readonly yoloStandingAlone?: boolean;
};

export type LgtmConjunctVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: LgtmConjunctRefuseReason; readonly detail: string };
const TARGET_SHAPE_FIELD_RE = /(?:^|\n)\s*target shape:\s*([^\n]+)/gi;
const LEAN_HEADING_RE = /(?:^|\n)\s*\*{0,2}Lean:\*{0,2}/;
const TABLE_HEADING_RE = /(?:^|\n)\s*##\s+Verified-claims table\b/;
/** Same wrapping as Lean: — zero to two asterisks independently on each side. */
const TARGET_DIGEST_HEADING_RE = /(?:^|\n)\s*\*{0,2}Target-digest:\*{0,2}/g;
const TARGET_DIGEST_VALUE_RE =
  /(?:^|\n)\s*\*{0,2}Target-digest:\*{0,2}[ \t]*sha256:([a-f0-9]{64})[ \t]*(?=\r?(?:\n|$))/g;

/** How many ids a block detail lists before it truncates. */
const DETAIL_ID_LIMIT = 5;

const CATALOG = new Set<string>(DESIGN_CRITIQUE_CATALOG_CHIPS);

let pendingIngestDiagnosticOverlay: string | undefined;

/** Attach shared stale-ready mapping text to the next ingest blocked throw (#4970). */
export function setPendingIngestDiagnosticOverlay(overlay: string | undefined): void {
  pendingIngestDiagnosticOverlay = overlay;
}

export class DesignCritiqueIngestBlockedError extends Error {
  readonly issueNumber: number;
  readonly reason: CompletedArcBlockReason;
  readonly detail: string;

  constructor(issueNumber: number, reason: CompletedArcBlockReason, detail: string) {
    const base = `issue:ingest refused #${issueNumber}: design-critique ${reason} (${detail}) -- nothing written.`;
    const extra = pendingIngestDiagnosticOverlay;
    pendingIngestDiagnosticOverlay = undefined;
    super(
      extra !== undefined && extra.length > 0
        ? `${base}
${extra}`
        : base,
    );
    this.name = "DesignCritiqueIngestBlockedError";
    this.issueNumber = issueNumber;
    this.reason = reason;
    this.detail = detail;
  }
}

export function isMoveForwardSynthesisShape(body: string): boolean {
  return MOVE_FORWARD_SYNTHESIS_SHAPE_RE.test(body);
}

export function isSynthesisAcceptedShape(body: string): boolean {
  return SYNTHESIS_SHAPE_RE.test(body) || isMoveForwardSynthesisShape(body);
}

export function isCancelledShape(body: string): boolean {
  return CANCELLED_SHAPE_RE.test(body);
}

function operativeLineStartOffset(match: RegExpMatchArray, token: string): number {
  const matchOffset = match.index ?? 0;
  const inner = match[0].search(token);
  return matchOffset + (inner >= 0 ? inner : 0);
}

/**
 * Parse operator utterance for Stop 1 materiality-bar (#5488).
 * Missing token keeps open (non-empty all-accept). Closed `ship-ready` / `lgtm`
 * resolve ship-ready. Issue/comment/critic English are data — pass the chat
 * utterance only.
 */
export function parseOperatorMaterialityBar(utterance: string): MaterialityBarParse {
  const hasShipReady = SHIP_READY_TOKEN_RE.test(utterance);
  const hasLgtm = LGTM_TOKEN_RE.test(utterance);
  if (hasShipReady) {
    return { kind: "resolved", bar: "ship-ready", source: "ship-ready" };
  }
  if (hasLgtm) {
    return { kind: "resolved", bar: "ship-ready", source: "lgtm" };
  }
  return { kind: "resolved", bar: "open", source: "default" };
}

/** Stop 1 materiality-bar record line. */
export function materialityBarRecordLine(bar: MaterialityBar): string {
  return `${MATERIALITY_BAR_FIELD} ${bar}`;
}

/** Latest operative `materiality-bar:` on a body, or null when absent. */
export function extractOperativeMaterialityBar(body: string): MaterialityBar | null {
  const re = new RegExp(MATERIALITY_BAR_FIELD_RE.source, "gi");
  let last: MaterialityBar | null = null;
  for (const match of body.matchAll(re)) {
    if (classifyPosition(body, operativeLineStartOffset(match, "materiality-bar:")) !== null) {
      continue;
    }
    const raw = (match[1] ?? "").toLowerCase();
    if (raw === "ship-ready" || raw === "open") last = raw;
  }
  return last;
}

export function hasOperativeMoveForwardYes(body: string): boolean {
  const re = new RegExp(MOVE_FORWARD_FIELD_RE.source, "gi");
  for (const match of body.matchAll(re)) {
    if (classifyPosition(body, operativeLineStartOffset(match, "move-forward:")) === null) {
      return true;
    }
  }
  return false;
}

export function hasOperativeCleanResultYes(body: string): boolean {
  const re = new RegExp(CLEAN_RESULT_FIELD_RE.source, "gi");
  for (const match of body.matchAll(re)) {
    if (classifyPosition(body, operativeLineStartOffset(match, "clean-result:")) === null) {
      return true;
    }
  }
  return false;
}

/**
 * LGTM / move-forward completion conjunct (#5488 Prefer-A Bound).
 * Separate from yolo standing. Fixture over parent-claimed / thread-derived
 * inputs — does not invent a parallel clearance engine.
 */
export function evaluateLgtmCompletionConjunct(input: LgtmConjunctInput): LgtmConjunctVerdict {
  if (input.materialityBar !== "ship-ready") {
    return {
      ok: false,
      reason: "ship-ready-required",
      detail: "LGTM completion requires recorded materiality-bar: ship-ready",
    };
  }
  if (input.yoloStandingAlone === true && !input.parentMoveForwardRecorded) {
    return {
      ok: false,
      reason: "yolo-alone",
      detail: "yolo standing alone never admits LGTM / empty-(a) / footnote-only",
    };
  }
  if (input.acceptedBlockerCount > 0) {
    return {
      ok: false,
      reason: "blocker-present",
      detail: `accepted blocks-the-design count is ${String(input.acceptedBlockerCount)}`,
    };
  }
  if (input.unresolvedBlockerResidualCount > 0) {
    return {
      ok: false,
      reason: "unresolved-blocker",
      detail: `unresolved blocker residual count is ${String(input.unresolvedBlockerResidualCount)}`,
    };
  }
  if (!input.parentMoveForwardRecorded) {
    return {
      ok: false,
      reason: "missing-move-forward",
      detail: "parent move-forward / LGTM disposition is missing",
    };
  }
  if (input.seatCensus.some((row) => row === "dispatch-fail")) {
    return {
      ok: false,
      reason: "dispatch-fail",
      detail: "dispatch-fail seat refuses LGTM completion",
    };
  }
  if (input.seatCensus.some((row) => row === "stub" || row === "blank")) {
    return {
      ok: false,
      reason: "stub-or-blank",
      detail: "stub / blank seat refuses LGTM completion",
    };
  }
  if (input.seatCensus.some((row) => row === "blocking-present")) {
    return {
      ok: false,
      reason: "blocker-present",
      detail: "seat census still carries blocks-the-design",
    };
  }
  // Promoted sharpens stay readiness obligations under ship-ready; unpromoted
  // seats are demoted to footnote before this conjunct sees them.
  if (input.seatCensus.some((row) => row === "sharpening-present")) {
    return {
      ok: false,
      reason: "stub-or-blank",
      detail: "promoted sharpens-framing remains unresolved under LGTM",
    };
  }
  const admissible =
    input.seatCensus.length > 0 &&
    input.seatCensus.every((row) => row === "clean-result" || row === "footnote-only");
  if (!admissible) {
    return {
      ok: false,
      reason: "stub-or-blank",
      detail: "LGTM requires each Round-1 seat to post clean-result or footnote-only census",
    };
  }
  return { ok: true };
}

/**
 * Path 1 / Path 2 empty-(a) / footnote-only waiver under a green LGTM conjunct
 * (#5488 limb 3). Classic non-empty all-accept stays required when ship-ready
 * is absent or the conjunct fails.
 */
export function emptyOrFootnoteCensusBindAllowed(input: {
  readonly materialityBar: MaterialityBar;
  readonly lgtmConjunct: LgtmConjunctVerdict;
}): boolean {
  return input.materialityBar === "ship-ready" && input.lgtmConjunct.ok;
}

/** Collect operative finding-class tokens from headings / `class:` lines. */
function operativeFindingClasses(body: string): Set<string> {
  const classes = new Set<string>();
  const re = new RegExp(OPERATIVE_FINDING_CLASS_RE.source, "gi");
  for (const match of body.matchAll(re)) {
    const token = match[1];
    if (typeof token !== "string" || token.length === 0) continue;
    if (classifyPosition(body, operativeLineStartOffset(match, token)) !== null) continue;
    classes.add(token.toLowerCase());
  }
  return classes;
}

const FINDING_CLASSES_FOOTNOTE_RE = /(?:^|\n)[ \t]*finding-classes:[ \t]*footnote\b/gi;

function hasOperativeFindingClassesFootnote(body: string): boolean {
  const re = new RegExp(FINDING_CLASSES_FOOTNOTE_RE.source, "gi");
  for (const match of body.matchAll(re)) {
    if (classifyPosition(body, operativeLineStartOffset(match, "finding-classes:")) === null) {
      return true;
    }
  }
  return false;
}

/**
 * Classify a Round-1 critic body into an LGTM seat census token.
 * Uses operative class headings / `class:` lines and clean-result fields —
 * prose that merely mentions a class token does not count.
 */
/** True when an operative line-start dispatch-fail marker is outside examples. */
function hasOperativeDispatchFail(body: string): boolean {
  return hasOperativeTokenMatch(body, DISPATCH_FAIL_FIELD_RE, "dispatch-fail");
}

/**
 * True when the body is a parent or Stop 1 triage record that may carry
 * materiality-bar. Critic English stays data (#5488 Greptile P1).
 */
function admitsMaterialityBarFallback(body: string): boolean {
  return /(?:^|\n)\s*role:\s*(?:parent|triage)\b/i.test(body);
}

export function classifyLgtmSeatCensus(body: string): LgtmSeatCensus {
  const trimmed = body.trim();
  if (trimmed.length === 0) return "blank";
  if (hasOperativeDispatchFail(body)) return "dispatch-fail";
  const classes = operativeFindingClasses(body);
  if (classes.has("blocks-the-design")) return "blocking-present";
  if (classes.has("sharpens-framing")) return "sharpening-present";
  if (hasOperativeCleanResultYes(body)) return "clean-result";
  if (classes.has("footnote") || hasOperativeFindingClassesFootnote(body)) {
    return "footnote-only";
  }
  return "stub";
}

/** True when the critic body records a promoted sharpen readiness obligation. */
export function hasPromotedSharpenMarker(body: string): boolean {
  const re = new RegExp(PROMOTED_SHARPEN_RE.source, "gi");
  for (const match of body.matchAll(re)) {
    if (classifyPosition(body, operativeLineStartOffset(match, "promoted:")) === null) {
      return true;
    }
  }
  return false;
}

/**
 * Under ship-ready, demote unpromoted sharpening seats to footnote-only so the
 * LGTM conjunct only sees promoted sharpens as unresolved obligations.
 */
export function mapSeatCensusUnderMaterialityBar(
  seat: LgtmSeatCensus,
  materialityBar: MaterialityBar,
  body: string,
): LgtmSeatCensus {
  if (materialityBar !== "ship-ready" || seat !== "sharpening-present") return seat;
  if (hasPromotedSharpenMarker(body)) return "sharpening-present";
  return "footnote-only";
}

/**
 * True arc boundary: cancel, or a synthesis that cites an existing successor lean.
 * Lone / cite-not-lean synthesis shapes do not close the arc (#5488 Greptile P1).
 */
function isAdmittedArcBoundary(comment: ThreadComment, thread: readonly ThreadComment[]): boolean {
  if (isCancelledShape(comment.body)) return true;
  if (!isSynthesisAcceptedShape(comment.body)) return false;
  const citations = scanCitations(comment.body).citations;
  if (citations.length === 0) return false;
  const prior = thread.filter((row) => row.id < comment.id);
  return resolveCitedLean(citations, byId(thread), latestSuccessorLean(prior)) !== undefined;
}

/**
 * Comments belonging to the cited lean's arc: after any prior admitted
 * synthesis/cancel, before the next. Pre-bind lean revisions and failed
 * synthesis shapes stay inside the same arc (#5488).
 * Boundaries walk an id-sorted copy so reversed thread order cannot leak
 * earlier arcs into the current LGTM check (#5488 Greptile P1).
 */
export function commentsInCitedLeanArc(
  comments: readonly ThreadComment[],
  citedLean: ThreadComment,
): readonly ThreadComment[] {
  const ordered = [...comments].sort((a, b) => a.id - b.id);
  let priorBoundaryId = 0;
  for (const comment of ordered) {
    if (comment.id >= citedLean.id) break;
    if (isAdmittedArcBoundary(comment, ordered)) priorBoundaryId = comment.id;
  }
  let nextBoundaryAfter = Number.POSITIVE_INFINITY;
  for (const comment of ordered) {
    if (comment.id <= citedLean.id) continue;
    if (isAdmittedArcBoundary(comment, ordered)) {
      nextBoundaryAfter = comment.id;
      break;
    }
  }
  return ordered.filter(
    (comment) => comment.id > priorBoundaryId && comment.id < nextBoundaryAfter,
  );
}

const PANEL_DEPOSIT_TOKEN_RE = /(?:^|\n)\s*panel-deposit\b/gi;
const PANEL_SEAT_LINE_RE = /(?:^|\n)\s*seat:\s*(\S+)/gi;
const PANEL_FAMILIES_FIELD_RE = /(?:^|\n)\s*families:\s*([^\n]+)/gi;
const PANEL_SIBLINGS_COUNT_RE = /(?:^|\n)\s*siblings:\s*(\d+)\b/gi;

/** True when an operative panel-deposit marker / siblings field is outside examples. */
function hasOperativePanelDeposit(body: string): boolean {
  if (!isPanelDepositBody(body)) return false;
  const depositRe = new RegExp(PANEL_DEPOSIT_TOKEN_RE.source, "gi");
  for (const match of body.matchAll(depositRe)) {
    if (classifyPosition(body, operativeLineStartOffset(match, "panel-deposit")) === null) {
      return true;
    }
  }
  const siblingsRe = new RegExp(PANEL_SIBLINGS_COUNT_RE.source, "gi");
  for (const match of body.matchAll(siblingsRe)) {
    if (classifyPosition(body, operativeLineStartOffset(match, "siblings:")) === null) {
      return true;
    }
  }
  return false;
}

/** Expected Round-1 seat count from the latest operative panel-deposit in the arc. */
function expectedRound1SeatCount(arcComments: readonly ThreadComment[]): number {
  let max = 0;
  for (const comment of arcComments) {
    const body = comment.body;
    if (!hasOperativePanelDeposit(body)) continue;
    const seatIds = new Set<string>();
    const seatRe = new RegExp(PANEL_SEAT_LINE_RE.source, "gi");
    for (const match of body.matchAll(seatRe)) {
      if (classifyPosition(body, operativeLineStartOffset(match, "seat:")) !== null) continue;
      const id = match[1]?.trim();
      if (id) seatIds.add(id);
    }
    if (seatIds.size === 0) {
      const familiesRe = new RegExp(PANEL_FAMILIES_FIELD_RE.source, "gi");
      for (const match of body.matchAll(familiesRe)) {
        if (classifyPosition(body, operativeLineStartOffset(match, "families:")) !== null) continue;
        for (const part of (match[1] ?? "").split(",")) {
          const id = part.trim();
          if (id) seatIds.add(id);
        }
      }
    }
    let siblings = Number.NaN;
    const siblingsRe = new RegExp(PANEL_SIBLINGS_COUNT_RE.source, "gi");
    for (const match of body.matchAll(siblingsRe)) {
      if (classifyPosition(body, operativeLineStartOffset(match, "siblings:")) !== null) continue;
      siblings = Number.parseInt(match[1] ?? "", 10);
    }
    const n = seatIds.size > 0 ? seatIds.size : Number.isFinite(siblings) ? siblings : 0;
    if (n > max) max = n;
  }
  return max;
}

/** Operative token outside fence / quote / strike / negation (#5488 Greptile P1). */
function hasOperativeTokenMatch(body: string, re: RegExp, token: string): boolean {
  const scan = new RegExp(re.source, "gi");
  for (const match of body.matchAll(scan)) {
    if (classifyPosition(body, operativeLineStartOffset(match, token)) === null) {
      return true;
    }
  }
  return false;
}

/** Same-line lean take-map: `blocks-the-design … accept-into-contract`. */
const ACCEPTED_BLOCKER_TAKE_ROW_RE =
  /(?:^|\n)[ \t]*blocks-the-design(?:[ \t]*:|[ \t]+)[^\n]*\baccept-into-contract\b/gi;
/** Same-line lean take-map: `blocks-the-design … defer|disagree|…`. */
const UNRESOLVED_BLOCKER_TAKE_ROW_RE =
  /(?:^|\n)[ \t]*blocks-the-design(?:[ \t]*:|[ \t]+)[^\n]*\b(?:disagree|defer|omission|unresolved)\b/gi;
const ACCEPT_INTO_CONTRACT_LINE_RE = /(?:^|\n)[ \t]*accept-into-contract\b/gi;
const UNRESOLVED_TAKE_LINE_RE = /(?:^|\n)[ \t]*(disagree|defer|omission|unresolved)\b/gi;

/** Line-start unresolved take; classify the matched word, not a fixed token. */
function hasOperativeUnresolvedTakeLine(body: string): boolean {
  const scan = new RegExp(UNRESOLVED_TAKE_LINE_RE.source, "gi");
  for (const match of body.matchAll(scan)) {
    const token = match[1];
    if (typeof token !== "string" || token.length === 0) continue;
    if (classifyPosition(body, operativeLineStartOffset(match, token)) === null) {
      return true;
    }
  }
  return false;
}

/**
 * Accepted blockers: same-line take-map row, or classified `blocks-the-design:`
 * finding paired with a line-start `accept-into-contract` take. Explanatory
 * prose mentions do not count (#5488 Greptile P1).
 */
function countAcceptedBlockersInBody(body: string): number {
  if (hasOperativeTokenMatch(body, ACCEPTED_BLOCKER_TAKE_ROW_RE, "blocks-the-design")) {
    return 1;
  }
  if (
    operativeFindingClasses(body).has("blocks-the-design") &&
    hasOperativeTokenMatch(body, ACCEPT_INTO_CONTRACT_LINE_RE, "accept-into-contract")
  ) {
    return 1;
  }
  return 0;
}

function unresolvedBlockerResidualsInBody(body: string): number {
  if (hasOperativeTokenMatch(body, UNRESOLVED_BLOCKER_TAKE_ROW_RE, "blocks-the-design")) {
    if (!hasOperativeTokenMatch(body, ACCEPT_INTO_CONTRACT_LINE_RE, "accept-into-contract")) {
      return 1;
    }
    return 0;
  }
  if (
    operativeFindingClasses(body).has("blocks-the-design") &&
    hasOperativeUnresolvedTakeLine(body) &&
    !hasOperativeTokenMatch(body, ACCEPT_INTO_CONTRACT_LINE_RE, "accept-into-contract")
  ) {
    return 1;
  }
  return 0;
}

/**
 * Thread-derived LGTM conjunct for a move-forward synthesis candidate (#5488).
 * Materiality bar and critic seats are scoped to the cited lean's arc only.
 * Reuses citation / lean resolution from the completed-arc path; does not
 * re-run pain/plain-English (those stay on finalizeComplete).
 */
export function evaluateMoveForwardThreadAdmission(input: {
  readonly comments: readonly ThreadComment[];
  readonly synthesis: ThreadComment;
  readonly citedLean: ThreadComment;
}): LgtmConjunctVerdict {
  const arcComments = commentsInCitedLeanArc(input.comments, input.citedLean);
  const fromLean = extractOperativeMaterialityBar(input.citedLean.body);
  // Fallback bar only from parent / Stop 1 triage — critic text cannot opt in (#5488).
  const fromArc = arcComments
    .filter((comment) => admitsMaterialityBarFallback(comment.body))
    .map((comment) => extractOperativeMaterialityBar(comment.body))
    .reverse()
    .find((bar) => bar !== null);
  const materialityBar = fromLean ?? fromArc ?? "open";
  const parentMoveForwardRecorded =
    isMoveForwardSynthesisShape(input.synthesis.body) ||
    hasOperativeMoveForwardYes(input.synthesis.body) ||
    hasOperativeMoveForwardYes(input.citedLean.body);
  // Round-1 seats only — targeted pain audits (non-empty audit-targets) stay
  // on evaluateCompletedArcRecord pain checks. Keep `audit-targets: none`
  // Round-1 posts that the critic brief requires (#5488).
  const criticLike = arcComments.filter((comment) => {
    if (comment.id === input.synthesis.id || comment.id === input.citedLean.id) return false;
    if (!/(?:^|\n)\s*role:\s*critic\b/i.test(comment.body)) return false;
    if (isVerifiedClaimsTableBody(comment.body)) return false;
    if (isSuccessorLeanBody(comment.body)) return false;
    if (isCancelledShape(comment.body)) return false;
    if (isSynthesisAcceptedShape(comment.body)) return false;
    const envelope = extractOperativeAuditTargets(comment.body);
    if (envelope !== null && !envelope.declaredNone && envelope.auditTargets.length > 0) {
      return false;
    }
    return true;
  });
  // Panel-deposit expected seats must all post before LGTM (#5488 P1).
  const expectedSeats = expectedRound1SeatCount(arcComments);
  if (expectedSeats > 0 && criticLike.length < expectedSeats) {
    return {
      ok: false,
      reason: "stub-or-blank",
      detail:
        `panel expected ${String(expectedSeats)} Round-1 seats; ` +
        `${String(criticLike.length)} posted`,
    };
  }
  const seatCensus: LgtmSeatCensus[] =
    criticLike.length > 0
      ? criticLike.map((comment) =>
          mapSeatCensusUnderMaterialityBar(
            classifyLgtmSeatCensus(comment.body),
            materialityBar,
            comment.body,
          ),
        )
      : ["stub"];
  let acceptedBlockerCount = countAcceptedBlockersInBody(input.citedLean.body);
  let unresolvedBlockerResidualCount = unresolvedBlockerResidualsInBody(input.citedLean.body);
  for (const comment of criticLike) {
    acceptedBlockerCount += countAcceptedBlockersInBody(comment.body);
    unresolvedBlockerResidualCount += unresolvedBlockerResidualsInBody(comment.body);
  }
  return evaluateLgtmCompletionConjunct({
    materialityBar,
    acceptedBlockerCount,
    unresolvedBlockerResidualCount,
    parentMoveForwardRecorded,
    seatCensus,
  });
}

/**
 * Operative `Target-digest:` line-start. Fence, quote, inline-code, strike,
 * and negation do not count — same classifyPosition family as citations (#4243).
 */
export function hasOperativeTargetDigestLine(body: string): boolean {
  const re = new RegExp(TARGET_DIGEST_HEADING_RE.source, "g");
  for (const match of body.matchAll(re)) {
    if (classifyPosition(body, operativeLineStartOffset(match, "Target-digest:")) === null) {
      return true;
    }
  }
  return false;
}

export function isSuccessorLeanBody(body: string): boolean {
  return LEAN_HEADING_RE.test(body) || hasOperativeTargetDigestLine(body);
}

/** First operative `Target-digest: sha256:` + 64 lowercase hex digits, or null. */
export function extractOperativeTargetDigest(body: string): string | null {
  const re = new RegExp(TARGET_DIGEST_VALUE_RE.source, "g");
  for (const match of body.matchAll(re)) {
    if (classifyPosition(body, operativeLineStartOffset(match, "Target-digest:")) !== null) {
      continue;
    }
    const digest = match[1];
    if (typeof digest === "string" && digest.length === 64) return digest;
  }
  return null;
}

/** SHA-256 of GitHub REST issue `body` bytes as returned. No extra newline. */
export function hashIssueBodyBytes(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export type TargetDigestAdmission =
  | { readonly status: "unpinned" }
  | { readonly status: "match"; readonly digest: string }
  | {
      readonly status: "blocked";
      readonly reason: "stale-target";
      readonly detail: string;
    };

/**
 * Ingest admission against the cited successor lean's Target-digest (#4243).
 * Legacy leans with no digest stay unpinned (admitted). Recut-without-digest
 * stays on #4237.
 */
export function evaluateTargetDigestAdmission(input: {
  readonly citedLeanBody: string;
  readonly liveIssueBody: string;
}): TargetDigestAdmission {
  const pinned = extractOperativeTargetDigest(input.citedLeanBody);
  if (pinned === null) {
    if (hasOperativeTargetDigestLine(input.citedLeanBody)) {
      return {
        status: "blocked",
        reason: "stale-target",
        detail:
          "cited successor lean carries Target-digest: but it is not sha256: plus 64 lowercase hex digits",
      };
    }
    return { status: "unpinned" };
  }
  const live = hashIssueBodyBytes(input.liveIssueBody);
  if (live !== pinned) {
    return {
      status: "blocked",
      reason: "stale-target",
      detail:
        `live REST issue body sha256:${live} does not match Target-digest sha256:${pinned}; ` +
        "cache is not admission",
    };
  }
  return { status: "match", digest: pinned };
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

/** Latest operative parent/triage `design-critique: cancelled, because ...`. */
export function latestCancelled(comments: readonly ThreadComment[]): ThreadComment | undefined {
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

const WARRANTED_SHAPE_RE = /(?:^|\n)\s*design-critique:\s*warranted,\s*because\b/i;

function hasOperativeWarrantedShape(body: string): boolean {
  const re = new RegExp(WARRANTED_SHAPE_RE.source, "gi");
  for (const match of body.matchAll(re)) {
    const matchOffset = match.index ?? 0;
    const inner = match[0].search(/design-critique:/i);
    const offset = matchOffset + (inner >= 0 ? inner : 0);
    if (classifyPosition(body, offset) === null) return true;
  }
  return false;
}

function latestStop1(comments: readonly ThreadComment[]): ThreadComment | undefined {
  let latest: ThreadComment | undefined;
  for (const comment of comments) {
    if (!isParentOrTriageAuthority(comment.body)) continue;
    if (!hasOperativeWarrantedShape(comment.body)) continue;
    if (latest === undefined || comment.id > latest.id) latest = comment;
  }
  return latest;
}

export function criticEnvelopes(
  comments: readonly ThreadComment[],
  afterCommentId: number,
): AuditEnvelope[] {
  const envelopes: AuditEnvelope[] = [];
  for (const comment of comments) {
    if (comment.id <= afterCommentId) continue;
    if (!CRITIC_ROLE_RE.test(comment.body)) continue;
    const envelope = extractOperativeAuditTargets(comment.body);
    if (envelope !== null) envelopes.push(envelope);
  }
  return envelopes;
}

function applyPainCoverage(
  verdict: CompletedArcVerdict,
  comments: readonly ThreadComment[],
  issueNumber: number | undefined,
): CompletedArcVerdict {
  if (verdict.status !== "complete") return verdict;
  const stop1 = latestStop1(comments);
  if (stop1 === undefined) return verdict;
  const pain = scanPainList(stop1.body);
  if (pain.malformed) {
    return {
      status: "blocked",
      reason: "malformed-pain",
      detail:
        "Stop 1 write-back " +
        String(stop1.id) +
        " pain: list is not a published closed form; accepted forms: " +
        ACCEPTED_PAIN_LIST_FORMS.join(" | "),
    };
  }
  if (!pain.present || pain.ids.length === 0) {
    return {
      status: "blocked",
      reason: "missing-pain",
      detail:
        "Stop 1 write-back " +
        String(stop1.id) +
        " has no operative non-vacuous pain: list; accepted forms: " +
        ACCEPTED_PAIN_LIST_FORMS.join(" | "),
    };
  }
  if (pain.duplicates.length > 0) {
    return {
      status: "blocked",
      reason: "malformed-pain",
      detail:
        "Stop 1 write-back " +
        String(stop1.id) +
        " repeats pain id(s) " +
        pain.duplicates.join(", ") +
        "; duplicate ids fail closed",
    };
  }
  const citedLean = comments.find((comment) => comment.id === verdict.citedLeanId);
  if (citedLean === undefined) {
    return {
      status: "blocked",
      reason: "unrelieved-pain",
      detail: "cited successor lean is missing from this thread",
    };
  }
  const byId = new Map<string, ReturnType<typeof scanPainCites>["cites"][number][]>();
  for (const cite of scanPainCites(citedLean.body).cites) {
    const rows = byId.get(cite.painId) ?? [];
    rows.push(cite);
    byId.set(cite.painId, rows);
  }
  const unknown = [...byId.keys()].filter((id) => !pain.ids.includes(id));
  if (unknown.length > 0) {
    return {
      status: "blocked",
      reason: "malformed-pain",
      detail:
        "successor lean cites unknown pain id(s) " +
        unknown.join(", ") +
        "; Stop 1 list is " +
        pain.ids.join(", "),
    };
  }
  const residual: string[] = [];
  const sameIssue: string[] = [];
  const deferred: string[] = [];
  const relieved: string[] = [];
  const conflicting: string[] = [];
  for (const id of pain.ids) {
    const rows = byId.get(id) ?? [];
    if (rows.length === 0) {
      residual.push(id);
      continue;
    }
    const dispositions = new Set(rows.map((row) => row.disposition));
    if (dispositions.size > 1) {
      conflicting.push(id);
      continue;
    }
    const row = rows[0];
    if (row === undefined || row.disposition === "does-not-relieve") {
      residual.push(id);
      continue;
    }
    if (row.disposition === "operator-deferred") {
      if (row.deferredIssueNumber === null) {
        conflicting.push(id);
        continue;
      }
      if (issueNumber === undefined || row.deferredIssueNumber === issueNumber) {
        sameIssue.push(id);
        continue;
      }
      deferred.push(id);
      continue;
    }
    relieved.push(id);
  }
  if (conflicting.length > 0) {
    return {
      status: "blocked",
      reason: "malformed-pain",
      detail:
        "successor lean has conflicting or incomplete dispositions for pain id(s) " +
        conflicting.join(", "),
    };
  }
  if (residual.length > 0 || sameIssue.length > 0) {
    const parts: string[] = [];
    if (residual.length > 0) {
      parts.push(`uncited residual pain id(s) ${residual.join(", ")}`);
    }
    if (sameIssue.length > 0) {
      parts.push(
        "operator-deferred " +
          sameIssue.join(", ") +
          " cites this issue" +
          (issueNumber === undefined ? "" : ` #${String(issueNumber)}`) +
          "; same-number leftover is not ingest clearance",
      );
    }
    return {
      status: "blocked",
      reason: "unrelieved-pain",
      detail: `${parts.join("; ")}; accepted cite forms: ${ACCEPTED_PAIN_CITE_FORMS.join(" | ")}`,
    };
  }
  const asserted = [...relieved, ...deferred];
  if (asserted.length === 0) return verdict;
  const audit = evaluateParentAudit(
    buildPainCoverageDeposit({
      leanCommentId: citedLean.id,
      deferredPainIds: asserted,
      criticEnvelopes: criticEnvelopes(comments, citedLean.id),
    }),
  );
  if (!audit.ok) {
    const codes = [...new Set(audit.failures.map((row) => row.code))].join(", ");
    return {
      status: "blocked",
      reason: "unresolved-pain-audit",
      detail:
        "pain id(s) " +
        asserted.join(", ") +
        " remain unresolved audit markers (" +
        codes +
        ") until a critic after successor lean " +
        String(citedLean.id) +
        " targets them",
    };
  }
  // #5233: after independent targeting clears, compose typed follow-through
  // for every targeting audit on this harvest. Missing carrier / blocking /
  // harvest-changing without a changed Bound-remedy digest refuse here so
  // path-1, chip, and intake share one authority.
  const followThrough = evaluateAccumulatedPainAuditFollowThrough({
    comments,
    citedLeanId: citedLean.id,
    assertedPainIds: asserted,
    isSuccessorLeanBody,
  });
  if (!followThrough.ok) {
    return {
      status: "blocked",
      reason: "unresolved-pain-audit",
      detail: followThrough.detail,
    };
  }
  return verdict;
}

/**
 * Exact level-2 `## In plain English` line (horizontal whitespace / CRLF via
 * trim). Prefix near-miss (`## In plain Englishness`) fails. Same classifyPosition
 * family as findBoundRemedyHeading (#5415).
 */
function matchPlainEnglishHeadingLine(line: string): { level: number; end: number } | null {
  if (!line.startsWith("#")) return null;
  let level = 0;
  while (level < line.length && line[level] === "#") level += 1;
  if (level !== 2) return null;
  if (level >= line.length || line[level] !== " ") return null;
  const headingText = line
    .slice(level + 1)
    .trim()
    .toLowerCase();
  if (headingText !== "in plain english") return null;
  return { level, end: line.length };
}

function findOperativePlainEnglishHeading(
  text: string,
): { readonly sectionStart: number; readonly headingOffset: number } | null {
  let offset = 0;
  for (const line of text.split("\n")) {
    const match = matchPlainEnglishHeadingLine(line);
    if (match !== null && classifyPosition(text, offset) === null) {
      return { sectionStart: offset + match.end, headingOffset: offset };
    }
    offset += line.length + 1;
  }
  return null;
}

function isOperativeLevel2HeadingLine(text: string, line: string, absoluteOffset: number): boolean {
  if (!line.startsWith("#")) return false;
  let hashes = 0;
  while (hashes < line.length && line[hashes] === "#") hashes += 1;
  if (hashes !== 2) return false;
  if (hashes < line.length && line[hashes] !== " " && line[hashes] !== "\r") return false;
  return classifyPosition(text, absoluteOffset) === null;
}

/** Lean-family reserved line-starts that end a plain-English slice (#5415). */
const PLAIN_ENGLISH_SLICE_END_RE =
  /^(?:\*{0,2}Lean:\*{0,2}|Spec-path:|Recut:|\*{0,2}Target-digest:\*{0,2}|design-critique:\s*synthesis accepted,\s*because\b)/i;

function slicePlainEnglishBody(text: string, sectionStart: number): string {
  const after = text.slice(sectionStart);
  let offset = 0;
  for (const line of after.split("\n")) {
    if (offset > 0) {
      const absolute = sectionStart + offset;
      const trimmed = line.trim();
      if (isOperativeLevel2HeadingLine(text, line, absolute)) break;
      if (PLAIN_ENGLISH_SLICE_END_RE.test(trimmed)) break;
    }
    offset += line.length + 1;
  }
  return after.slice(0, offset);
}

/**
 * Comment-lead lines only (`model: <slug>`, `role: triage|critic|parent`).
 * Case-sensitive keys; closed role set — prose like `Role: the operator…`
 * must remain summary (#5415).
 */
const PLAIN_ENGLISH_METADATA_LINE_RE = /^(?:model:\s*\S+|role:\s*(?:triage|critic|parent)\b)/;

function stripPlainEnglishMetadataLines(slice: string): string {
  return slice
    .split("\n")
    .filter((line) => !PLAIN_ENGLISH_METADATA_LINE_RE.test(line.trim()))
    .join("\n");
}

function lineNumberAt(text: string, offset: number): number {
  let line = 1;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

function leanResolutionDetail(lean: ThreadComment): string {
  const parts: string[] = [];
  const leanMatch = lean.body.match(LEAN_HEADING_RE);
  if (leanMatch !== null) {
    parts.push(
      `Lean: token matched at line ${String(lineNumberAt(lean.body, leanMatch.index ?? 0))}`,
    );
  }
  if (hasOperativeTargetDigestLine(lean.body)) {
    parts.push("operative Target-digest: matched");
  }
  return parts.length > 0 ? parts.join("; ") : "successor-lean predicate matched";
}

type PlainEnglishPresence = { readonly ok: true } | { readonly ok: false; readonly detail: string };

function plainEnglishPresenceOnBody(
  body: string,
  artifactLabel: string,
  id: number,
): PlainEnglishPresence {
  const heading = findOperativePlainEnglishHeading(body);
  if (heading === null) {
    return {
      ok: false,
      detail: `${artifactLabel} ${String(id)} lacks an operative ## In plain English heading`,
    };
  }
  const slice = stripPlainEnglishMetadataLines(
    slicePlainEnglishBody(body, heading.sectionStart),
  ).trim();
  if (slice.length === 0) {
    return {
      ok: false,
      detail: `${artifactLabel} ${String(id)} has ## In plain English with an empty body slice`,
    };
  }
  return { ok: true };
}

/**
 * After lean/table/pain clearance, require operative non-empty ## In plain English
 * on both citedLeanId and synthesisCommentId (#5415). Does not mask earlier reasons.
 */
function applyPlainEnglishPresence(
  verdict: CompletedArcVerdict,
  comments: readonly ThreadComment[],
): CompletedArcVerdict {
  if (verdict.status !== "complete") return verdict;
  const failures: string[] = [];
  const lean = comments.find((comment) => comment.id === verdict.citedLeanId);
  if (lean === undefined) {
    failures.push(`cited lean ${String(verdict.citedLeanId)} is missing from this thread`);
  } else {
    const leanPresence = plainEnglishPresenceOnBody(lean.body, "cited lean", lean.id);
    if (!leanPresence.ok) {
      failures.push(`${leanPresence.detail} (${leanResolutionDetail(lean)})`);
    }
  }
  const synthesis = comments.find((comment) => comment.id === verdict.synthesisCommentId);
  if (synthesis === undefined) {
    failures.push(`synthesis ${String(verdict.synthesisCommentId)} is missing from this thread`);
  } else {
    const synthPresence = plainEnglishPresenceOnBody(synthesis.body, "synthesis", synthesis.id);
    if (!synthPresence.ok) failures.push(synthPresence.detail);
  }
  if (failures.length === 0) return verdict;
  return {
    status: "blocked",
    reason: "missing-plain-english",
    detail: `${failures.join("; ")}; recovery: patch named comment id(s), then re-evaluate / re-chip`,
  };
}

function finalizeComplete(
  comments: readonly ThreadComment[],
  verdict: CompletedArcVerdict,
  issueNumber: number | undefined,
): CompletedArcVerdict {
  return applyPlainEnglishPresence(
    applyPainCoverage(refuseSetLevelBody(comments, verdict), comments, issueNumber),
    comments,
  );
}

function refuseSetLevelBody(
  comments: readonly ThreadComment[],
  verdict: CompletedArcVerdict,
): CompletedArcVerdict {
  if (verdict.status !== "complete" || !latestTargetShapeIsSetLevel(comments)) {
    return verdict;
  }
  return {
    status: "blocked",
    reason: "set-level-body",
    detail:
      "completed-arc record is present but the latest target shape is set-level; " +
      "ingest waits on a rewritten body or a newly filed issue (comment id " +
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
  if (isMoveForwardSynthesisShape(comment.body)) {
    const lgtm = evaluateMoveForwardThreadAdmission({
      comments,
      synthesis: comment,
      citedLean,
    });
    if (!lgtm.ok) {
      return {
        status: "blocked",
        reason: "missing-record",
        detail:
          `move-forward synthesis ${String(comment.id)} refused by LGTM conjunct (${lgtm.reason}): ` +
          `${lgtm.detail}; recovery: record materiality-bar: ship-ready, parent move-forward, ` +
          "zero accepted/unresolved blockers, and clean-result or footnote-only seat census",
      };
    }
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
 * clear a later lean. A panel-deposit is in-flight even before critic posts.
 */
export function evaluateCompletedArcRecord(input: {
  readonly labels?: readonly string[];
  readonly comments: readonly ThreadComment[];
  readonly issueNumber?: number;
}): CompletedArcVerdict {
  const comments = input.comments;
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
      const latestMatching = matching.reduce((a, b) =>
        a.synthesisCommentId >= b.synthesisCommentId ? a : b,
      );
      const complete = finalizeComplete(recutComments, latestMatching, input.issueNumber);
      if (complete.status !== "complete") {
        return complete;
      }
      const earliestMatching = matching.reduce((a, b) =>
        a.synthesisCommentId <= b.synthesisCommentId ? a : b,
      );
      const suffix = recutComments.filter(
        (comment) => comment.id > earliestMatching.synthesisCommentId,
      );
      if (isInFlightCritiqueThread(suffix)) {
        return {
          status: "blocked",
          reason: "later-arc-in-flight",
          detail:
            "comments after completed-arc record synthesis " +
            String(earliestMatching.synthesisCommentId) +
            " still look in-flight while the latest successor lean is still " +
            String(earliestMatching.citedLeanId) +
            "; ingest waits on later-arc completion (a new successor-lean heading plus a record that cites it)",
        };
      }
      return complete;
    }
    const latestCompleteId = completeRecords.reduce(
      (max, record) => Math.max(max, record.synthesisCommentId),
      0,
    );
    const laterSynthesis = synthesis.filter((comment) => comment.id > latestCompleteId);
    if (laterSynthesis.length > 0) {
      const latest = laterSynthesis.reduce((a, b) => (a.id >= b.id ? a : b));
      return finalizeComplete(
        recutComments,
        verdictForSynthesis(latest, recutComments),
        input.issueNumber,
      );
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
    return finalizeComplete(
      recutComments,
      verdictForSynthesis(latest, recutComments),
      input.issueNumber,
    );
  }
  // Labels are not SoT: in-arc membership is thread-only (#4298).
  const inArc = isInFlightCritiqueThread(recutComments);
  if (!inArc) {
    return { status: "not-in-arc" };
  }
  return {
    status: "blocked",
    reason: "missing-record",
    detail:
      "design-critique is in flight but the completed-arc record is missing: " +
      "`design-critique: synthesis accepted, because ...` or " +
      `\`${MOVE_FORWARD_SYNTHESIS_LEAD}\` citing the accepted successor lean; ` +
      `accepted forms: ${ACCEPTED_CITATION_FORMS.join(" | ")}`,
  };
}

export function assertCompletedArcAllowsIngest(input: {
  readonly issueNumber: number;
  readonly labels?: readonly string[];
  readonly comments: readonly ThreadComment[];
}): CompletedArcVerdict {
  const verdict = evaluateCompletedArcRecord({
    labels: input.labels,
    comments: input.comments,
    issueNumber: input.issueNumber,
  });
  if (verdict.status === "blocked") {
    throw new DesignCritiqueIngestBlockedError(input.issueNumber, verdict.reason, verdict.detail);
  }
  return verdict;
}

const SYNTHESIS_NO_COMMA_NEAR_MISS_RE =
  /(?:^|\n)\s*design-critique:\s*synthesis accepted because\b/i;

/** Map REST issue comments onto the completed-arc ThreadComment shape. */
export function threadCommentsFromIssueComments(
  comments: readonly { readonly id?: number; readonly body?: string }[],
): ThreadComment[] {
  const out: ThreadComment[] = [];
  for (const comment of comments) {
    if (typeof comment.id === "number" && typeof comment.body === "string") {
      out.push({ id: comment.id, body: comment.body });
    }
  }
  return out;
}

export function nearMissCommaDiagnostic(comments: readonly ThreadComment[]): string {
  for (const comment of comments) {
    if (
      SYNTHESIS_NO_COMMA_NEAR_MISS_RE.test(comment.body) &&
      !isSynthesisAcceptedShape(comment.body)
    ) {
      return (
        "; near-miss: comment " +
        String(comment.id) +
        " has `synthesis accepted because` without the required comma (`synthesis accepted, because`)"
      );
    }
  }
  return "";
}

export class IngestReadyCompletedArcProofError extends Error {
  readonly issueNumber: number;
  readonly verdict: CompletedArcVerdict;

  constructor(
    issueNumber: number,
    verdict: CompletedArcVerdict,
    comments: readonly ThreadComment[] = [],
  ) {
    const base =
      verdict.status === "blocked"
        ? `design-critique:ingest-ready remaining-set refused: ${verdict.reason} (${verdict.detail})`
        : verdict.status === "not-in-arc"
          ? "design-critique:ingest-ready remaining-set refused: live thread is not a complete completed-arc record (not-in-arc); comments present is not complete"
          : "design-critique:ingest-ready remaining-set refused: live-thread evaluateCompletedArcRecord is not complete";
    super(base + nearMissCommaDiagnostic(comments));
    this.name = "IngestReadyCompletedArcProofError";
    this.issueNumber = issueNumber;
    this.verdict = verdict;
  }
}

/**
 * Live-thread proof for ingest-ready remaining-set (#4700).
 * Comments present is not complete. Does not recut ingest clearance.
 * Target-digest admission is composed at applyIngestReadyRemainingSet (#4995).
 */
export function proveLiveThreadCompletedArcForIngestReady(input: {
  readonly comments: readonly ThreadComment[];
  readonly issueNumber?: number;
}): CompletedArcVerdict {
  return evaluateCompletedArcRecord({
    comments: input.comments,
    issueNumber: input.issueNumber,
  });
}

export type IngestReadyRemainingSetResult =
  | {
      readonly ok: true;
      readonly remaining: string[];
      readonly add: readonly string[];
      readonly remove: readonly string[];
    }
  | {
      readonly ok: false;
      readonly verdict: CompletedArcVerdict;
      readonly digestAdmission?: TargetDigestAdmission;
      readonly liveIssueBody?: string;
      readonly citedLeanBody?: string;
    };

/**
 * Shared ingest-ready remaining-set write. Comment + live body fetch are the
 * caller's job (fetchIssueComments + live REST body). Both runDesignCritiqueChip
 * and ScmLabelClient.apply exclusive fold use this helper. Composes
 * evaluateCompletedArcRecord with evaluateTargetDigestAdmission before any
 * label mutation (#4995 / #4700). Blocked / not-complete returns `{ ok: false }`
 * (callers refuse without a new product throw). not-in-arc does not write.
 * Unpinned leans stay admitted.
 */
export function applyIngestReadyRemainingSet(
  client: LabelClient,
  repo: string,
  issueNumber: number,
  comments: readonly ThreadComment[],
  liveIssueBody: string,
): IngestReadyRemainingSetResult {
  const verdict = proveLiveThreadCompletedArcForIngestReady({ comments, issueNumber });
  if (verdict.status !== "complete") {
    return { ok: false, verdict };
  }
  const cited = comments.find((comment) => comment.id === verdict.citedLeanId);
  const citedLeanBody = cited?.body ?? "";
  const digestAdmission = evaluateTargetDigestAdmission({
    citedLeanBody,
    liveIssueBody,
  });
  if (digestAdmission.status === "blocked") {
    return {
      ok: false,
      verdict: {
        status: "blocked",
        reason: "stale-target",
        detail: digestAdmission.detail,
      },
      digestAdmission,
      liveIssueBody,
      citedLeanBody,
    };
  }
  const written = writeDesignCritiqueCatalogRemainingSet(
    client,
    repo,
    issueNumber,
    "design-critique:ingest-ready",
  );
  return { ok: true, ...written };
}
