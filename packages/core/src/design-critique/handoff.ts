/**
 * Parent-class Handoff after unrelieved pain plus recut (#4531).
 *
 * Print condition is not residualHeadingCount / Retry. open-question: is
 * Spec-path-class wrapping with classifyPosition; it is not a successor-lean
 * classifier and is not unioned into SPEC_PATH_TOKEN_RE.
 */

import { leanCarriesSpecPathToken } from "./auto-stamp-chip.js";
import { classifyPosition, type PainCite, scanPainCites } from "./citation-grammar.js";
import { isSuccessorLeanBody } from "./completed-arc-record.js";

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

function hasOperativeSupersedesPriorLean(body: string): boolean {
  const re = new RegExp(SUPERSEDES_RE.source, "gi");
  for (const match of body.matchAll(re)) {
    if (classifyPosition(body, match.index ?? 0) === null) {
      return true;
    }
  }
  return false;
}

export type HandoffPrintInput = {
  readonly mapBody: string;
  readonly stop1PainIds: readonly string[];
  /** Cap spend does not suppress print; Handoff is parent-class. */
  readonly dualStopCapSpent?: boolean;
};

export type HandoffPrintVerdict = {
  readonly print: boolean;
  readonly unrelievedPain: boolean;
  readonly recutConjunct: boolean;
};

/**
 * Print Handoff when the posted map has operative does-not-relieve or uncited
 * pain, plus operative Spec-path / Recut or an operative supersession of a
 * prior successor-lean id. Does not clone residualHeadingCount.
 */
export function evaluateHandoffPrint(input: HandoffPrintInput): HandoffPrintVerdict {
  const cites = scanPainCites(input.mapBody).cites;
  const unrelievedPain =
    hasOperativeDoesNotRelieve(cites) || hasUncitedPain(cites, input.stop1PainIds);
  const recutConjunct =
    leanCarriesSpecPathToken(input.mapBody) || hasOperativeSupersedesPriorLean(input.mapBody);
  return {
    print: unrelievedPain && recutConjunct,
    unrelievedPain,
    recutConjunct,
  };
}

export type DualStopReservedSlotInput = {
  readonly numberedCap: number;
  readonly criticPostsUsed: number;
  readonly mapCarriesOperativeRelieves: boolean;
  readonly reservedPainAuditPostsUsed: number;
  readonly operatorRaisedCap: boolean;
};

export type DualStopReservedSlotVerdict = {
  readonly inCapWithoutRaise: boolean;
  readonly needsRaise: boolean;
};

/**
 * One in-cap pain-audit when the map carries operative relieves: P* and the
 * numbered cap is already spent. Not always-on +1 on the N=1 default of two
 * posts. A second extra post still needs a raise. Not an ingest reason.
 */
export function evaluateDualStopReservedSlot(
  input: DualStopReservedSlotInput,
): DualStopReservedSlotVerdict {
  const capSpent = input.criticPostsUsed >= input.numberedCap;
  if (!capSpent || !input.mapCarriesOperativeRelieves) {
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
