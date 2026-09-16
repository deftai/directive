/**
 * Parent-class Handoff after unrelieved pain plus recut (#4531),
 * or same-P* relieves Recut-supersedes (#4554).
 *
 * Print condition is not residualHeadingCount / Retry. open-question: is
 * Spec-path-class wrapping with classifyPosition; it is not a successor-lean
 * classifier and is not unioned into SPEC_PATH_TOKEN_RE.
 */

import { leanCarriesSpecPathToken } from "./auto-stamp-chip.js";
import { classifyPosition, type PainCite, scanPainCites } from "./citation-grammar.js";
import { isSuccessorLeanBody, type ThreadComment } from "./completed-arc-record.js";

const OPEN_QUESTION_RE = /(?:^|\n)\s*\*{0,2}open-question:\*{0,2}/g;
const OPEN_QUESTION_VALUE_RE =
  /(?:^|\n)\s*\*{0,2}open-question:\*{0,2}[ \t]*([^\r\n]*?)[ \t]*(?=\r?(?:\n|$))/g;
const SUPERSEDES_RE = /\bSupersedes(?:\s+comment|\s+successor lean)?[:\s]+(\d{8,})\b/gi;
const PARENT_ROLE_RE = /(?:^|\n)\s*role:\s*parent\b/i;
const LEAN_HEADING_RE = /(?:^|\n)\s*\*{0,2}Lean:\*{0,2}/;

function tokenOffset(match: RegExpMatchArray, token: string): number {
  const matchOffset = match.index ?? 0;
  const inner = match[0].search(token);
  return matchOffset + (inner >= 0 ? inner : 0);
}

/** Operative `open-question:` line-start. Fence, quote, strike, code do not count. */
export function hasOperativeOpenQuestionLine(body: string): boolean {
  const re = new RegExp(OPEN_QUESTION_RE.source, "g");
  for (const match of body.matchAll(re)) {
    if (classifyPosition(body, tokenOffset(match, "open-question:")) === null) {
      return true;
    }
  }
  return false;
}

/** First operative open-question sentence (rest of the line), or null. */
export function extractOperativeOpenQuestion(body: string): string | null {
  const re = new RegExp(OPEN_QUESTION_VALUE_RE.source, "g");
  for (const match of body.matchAll(re)) {
    if (classifyPosition(body, tokenOffset(match, "open-question:")) !== null) continue;
    return (match[1] ?? "").trim();
  }
  return null;
}

export function handoffOpensSuccessorLeanToken(body: string): boolean {
  return LEAN_HEADING_RE.test(body);
}

export function isParentHandoffBody(body: string): boolean {
  return PARENT_ROLE_RE.test(body) && hasOperativeOpenQuestionLine(body);
}

function hasOperativeDoesNotRelieve(cites: readonly PainCite[]): boolean {
  return cites.some((cite) => cite.disposition === "does-not-relieve");
}

function hasUncitedPain(cites: readonly PainCite[], stop1PainIds: readonly string[]): boolean {
  const cited = new Set(cites.map((cite) => cite.painId));
  return stop1PainIds.some((id) => !cited.has(id));
}

function operativeRelievesIds(cites: readonly PainCite[]): Set<string> {
  return new Set(
    cites.filter((cite) => cite.disposition === "relieves").map((cite) => cite.painId),
  );
}

function collectSupersededSuccessorLeans(
  body: string,
  comments: readonly ThreadComment[] | undefined,
): ThreadComment[] {
  if (comments === undefined || comments.length === 0) return [];
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const found: ThreadComment[] = [];
  const re = new RegExp(SUPERSEDES_RE.source, "gi");
  for (const match of body.matchAll(re)) {
    if (classifyPosition(body, match.index ?? 0) !== null) continue;
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const cited = byId.get(id);
    if (cited !== undefined && isSuccessorLeanBody(cited.body)) found.push(cited);
  }
  return found;
}

function hasOperativeSupersedesPriorLean(
  body: string,
  comments: readonly ThreadComment[] | undefined,
): boolean {
  return collectSupersededSuccessorLeans(body, comments).length > 0;
}

function hasHarvestRelievesOverlap(
  mapBody: string,
  comments: readonly ThreadComment[] | undefined,
  stop1PainIds: readonly string[],
): boolean {
  if (!isSuccessorLeanBody(mapBody)) return false;
  const admitted = new Set(stop1PainIds);
  if (admitted.size === 0) return false;
  const current = operativeRelievesIds(scanPainCites(mapBody).cites);
  if (current.size === 0) return false;
  for (const prior of collectSupersededSuccessorLeans(mapBody, comments)) {
    const priorRelieves = operativeRelievesIds(scanPainCites(prior.body).cites);
    for (const painId of current) {
      if (admitted.has(painId) && priorRelieves.has(painId)) return true;
    }
  }
  return false;
}

export type HandoffPrintInput = {
  readonly mapBody: string;
  readonly stop1PainIds: readonly string[];
  /** Cap spend does not suppress print; Handoff is parent-class. */
  readonly dualStopCapSpent?: boolean;
  /** Thread comments: prior successor leans for Recut-supersedes and harvest overlap. */
  readonly comments?: readonly ThreadComment[];
};

export type HandoffPrintVerdict = {
  readonly print: boolean;
  readonly unrelievedPain: boolean;
  readonly recutConjunct: boolean;
  /** Same-P* operative relieves Recut-superseding a prior successor relieves map. */
  readonly harvestRelievesOverlap: boolean;
};

/**
 * Print Handoff when unrelieved pain plus recut, or when a successor map has
 * operative relieves of the same P* as a prior successor map it Recut-supersedes.
 * Keep dest unrelieved print and OR the harvest overlap. Does not clone
 * residualHeadingCount. Does not scrape class tokens.
 */
export function evaluateHandoffPrint(input: HandoffPrintInput): HandoffPrintVerdict {
  const cites = scanPainCites(input.mapBody).cites;
  const unrelievedPain =
    hasOperativeDoesNotRelieve(cites) || hasUncitedPain(cites, input.stop1PainIds);
  const recutConjunct =
    leanCarriesSpecPathToken(input.mapBody) ||
    hasOperativeSupersedesPriorLean(input.mapBody, input.comments);
  const harvestRelievesOverlap = hasHarvestRelievesOverlap(
    input.mapBody,
    input.comments,
    input.stop1PainIds,
  );
  return {
    print: (unrelievedPain && recutConjunct) || harvestRelievesOverlap,
    unrelievedPain,
    recutConjunct,
    harvestRelievesOverlap,
  };
}

export type DualStopReservedSlotInput = {
  readonly numberedCap: number;
  readonly criticPostsUsed: number;
  /** Relieves plus different-issue deferred, as applyPainCoverage computes asserted. */
  readonly mapCarriesAssertedPainCoverage: boolean;
  readonly reservedPainAuditPostsUsed: number;
  readonly operatorRaisedCap: boolean;
};

export type DualStopReservedSlotVerdict = {
  readonly inCapWithoutRaise: boolean;
  readonly needsRaise: boolean;
};

/**
 * One in-cap pain-audit when the map carries asserted pain coverage (relieves
 * plus deferred) and the numbered cap is already spent. Not always-on +1 on
 * the N=1 default of six posts. A second extra post still needs a raise. Not
 * an ingest reason.
 */
export function evaluateDualStopReservedSlot(
  input: DualStopReservedSlotInput,
): DualStopReservedSlotVerdict {
  const capSpent = input.criticPostsUsed >= input.numberedCap;
  if (!capSpent || !input.mapCarriesAssertedPainCoverage) {
    return {
      inCapWithoutRaise: false,
      needsRaise: capSpent && !input.operatorRaisedCap,
    };
  }
  if (input.reservedPainAuditPostsUsed === 0) {
    return { inCapWithoutRaise: true, needsRaise: false };
  }
  return { inCapWithoutRaise: false, needsRaise: !input.operatorRaisedCap };
}

export type PostHandoffStop1Input = {
  readonly afterHandoff: boolean;
  readonly bodyWouldSelectRefutation: boolean;
};

export type PostHandoffStop1Verdict = {
  readonly charter: "open critique" | "refutation";
  readonly recordRefutationTarget: boolean;
};

/**
 * Post-handoff Stop 1 is open critique and omits refutation-target even when
 * the issue body would select refutation. Stop 2 does not re-select from the
 * body on that write-back.
 */
export function postHandoffStop1Writeback(input: PostHandoffStop1Input): PostHandoffStop1Verdict {
  if (input.afterHandoff) {
    return { charter: "open critique", recordRefutationTarget: false };
  }
  return {
    charter: input.bodyWouldSelectRefutation ? "refutation" : "open critique",
    recordRefutationTarget: true,
  };
}

/** Handoff with only open-question: is not a successor lean. */
export function openQuestionClassifiesAsSuccessorLean(body: string): boolean {
  return isSuccessorLeanBody(body);
}
