/**
 * Yolo leftover-pain handling (#4593): split/defer/deliver recipe, Dual-stop
 * posts-not-seats, and pain-audit follow-through after a bind lean.
 *
 * Does not NLP-grade Bound-remedy English (ADR-005). Does not waive #4592
 * path-1 refuse. Live parent turns stay unenforced; these are fixtures.
 */

import { type PainCite, scanPainCites } from "./citation-grammar.js";
import { isSuccessorLeanBody } from "./completed-arc-record.js";

export type PainAuditFindingClass = "blocking" | "sharpening" | "footnote";

export type PainCiteLeanKind = "bind" | "retraction" | "intermediate";

export function mapCarriesAssertedPainCoverage(
  mapBody: string,
  stop1PainIds: readonly string[],
  issueNumber: number | undefined,
): boolean {
  return (
    assertedPainIdsFromCites(scanPainCites(mapBody).cites, stop1PainIds, issueNumber).length > 0
  );
}

/** Same asserted set applyPainCoverage uses: relieves plus different-issue deferred. */
export function assertedPainIdsFromCites(
  cites: readonly PainCite[],
  stop1PainIds: readonly string[],
  issueNumber: number | undefined,
): string[] {
  const byId = new Map<string, PainCite[]>();
  for (const cite of cites) {
    const rows = byId.get(cite.painId) ?? [];
    rows.push(cite);
    byId.set(cite.painId, rows);
  }
  const asserted: string[] = [];
  for (const id of stop1PainIds) {
    const rows = byId.get(id) ?? [];
    if (rows.length === 0) continue;
    const dispositions = new Set(rows.map((row) => row.disposition));
    if (dispositions.size > 1) continue;
    const row = rows[0];
    if (row === undefined || row.disposition === "does-not-relieve") continue;
    if (row.disposition === "operator-deferred") {
      if (row.deferredIssueNumber === null) continue;
      if (issueNumber === undefined || row.deferredIssueNumber === issueNumber) continue;
      asserted.push(id);
      continue;
    }
    asserted.push(id);
  }
  return asserted;
}

export function evaluateYoloLeftoverRecommendation(input: {
  readonly yoloMode: boolean;
  readonly uncitedOrDoesNotRelieve: boolean;
  readonly recutHasDeliverableRemainder: boolean;
}): { readonly recommendLeftoverPath: boolean } {
  return {
    recommendLeftoverPath:
      input.yoloMode && input.uncitedOrDoesNotRelieve && input.recutHasDeliverableRemainder,
  };
}

/** Leftover issue number from the parent own issue-create output only. */
export function recordLeftoverIssueNumber(
  parentIssueCreateOutput: { readonly number: number } | null,
): number | null {
  if (parentIssueCreateOutput === null) return null;
  const n = parentIssueCreateOutput.number;
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

export function evaluateContinueRemainder(input: {
  readonly leftoverFiled: boolean;
  readonly dualStopPostsRemaining: number;
  readonly finishStillPossible: boolean;
}): { readonly continueCurrentArc: boolean } {
  return {
    continueCurrentArc:
      input.leftoverFiled && input.dualStopPostsRemaining > 0 && input.finishStillPossible,
  };
}

export function evaluateFinishStillPossible(input: {
  readonly blockingCounts: readonly number[];
  readonly primaryBlockingHeadings: readonly string[];
}): {
  readonly finishStillPossible: boolean;
  readonly haltOnRepeatPrimary: boolean;
} {
  if (input.blockingCounts.length < 2) {
    return { finishStillPossible: true, haltOnRepeatPrimary: false };
  }
  const last = input.blockingCounts[input.blockingCounts.length - 1];
  const prev = input.blockingCounts[input.blockingCounts.length - 2];
  if (last === undefined || prev === undefined) {
    return { finishStillPossible: true, haltOnRepeatPrimary: false };
  }
  const lastHeading = input.primaryBlockingHeadings[input.primaryBlockingHeadings.length - 1];
  const prevHeading = input.primaryBlockingHeadings[input.primaryBlockingHeadings.length - 2];
  const haltOnRepeatPrimary =
    typeof lastHeading === "string" && lastHeading.length > 0 && lastHeading === prevHeading;
  return {
    finishStillPossible: last < prev && !haltOnRepeatPrimary,
    haltOnRepeatPrimary,
  };
}

export function evaluateBoundRemedyCites(input: {
  readonly unmetIds: readonly string[];
  readonly coveredIds: readonly string[];
  readonly cites: readonly PainCite[];
}): { readonly ok: boolean } {
  for (const cite of input.cites) {
    if (cite.disposition === "operator-deferred" && !input.unmetIds.includes(cite.painId)) {
      return { ok: false };
    }
    if (cite.disposition === "relieves" && !input.coveredIds.includes(cite.painId)) {
      return { ok: false };
    }
  }
  return { ok: true };
}

export function evaluatePainCitePlacement(input: {
  readonly kind: PainCiteLeanKind;
  readonly body: string;
}): { readonly allowed: boolean; readonly operativeCiteCount: number } {
  const cites = scanPainCites(input.body).cites;
  if (input.kind === "intermediate") {
    return { allowed: cites.length === 0, operativeCiteCount: cites.length };
  }
  return { allowed: true, operativeCiteCount: cites.length };
}

export function evaluatePainAuditFollowThrough(input: {
  readonly findingClasses: readonly PainAuditFindingClass[];
  readonly harvestChanged: boolean;
}): {
  readonly postRetractionThenHandoff: boolean;
  readonly bindableWithoutExtraLean: boolean;
  readonly recordingOnlyParentComment: boolean;
  readonly newBindLeanAndAudit: boolean;
  readonly spendsNumberedDualStopPost: boolean;
  readonly movesCriticEnvelopes: boolean;
  readonly isRelief: boolean;
} {
  const hasBlocking = input.findingClasses.includes("blocking");
  const hasSharpening = input.findingClasses.includes("sharpening");
  if (hasBlocking) {
    return {
      postRetractionThenHandoff: true,
      bindableWithoutExtraLean: false,
      recordingOnlyParentComment: false,
      newBindLeanAndAudit: false,
      spendsNumberedDualStopPost: false,
      movesCriticEnvelopes: false,
      isRelief: false,
    };
  }
  if (hasSharpening && input.harvestChanged) {
    return {
      postRetractionThenHandoff: false,
      bindableWithoutExtraLean: false,
      recordingOnlyParentComment: false,
      newBindLeanAndAudit: true,
      spendsNumberedDualStopPost: true,
      movesCriticEnvelopes: true,
      isRelief: false,
    };
  }
  if (hasSharpening) {
    return {
      postRetractionThenHandoff: false,
      bindableWithoutExtraLean: true,
      recordingOnlyParentComment: true,
      newBindLeanAndAudit: false,
      spendsNumberedDualStopPost: false,
      movesCriticEnvelopes: false,
      isRelief: false,
    };
  }
  return {
    postRetractionThenHandoff: false,
    bindableWithoutExtraLean: true,
    recordingOnlyParentComment: false,
    newBindLeanAndAudit: false,
    spendsNumberedDualStopPost: false,
    movesCriticEnvelopes: false,
    isRelief: false,
  };
}

export function evaluateYoloStandingLeftoverScope(input: {
  readonly allAcceptMap: boolean;
  readonly leanCarriesOperatorConfirmedSplit: boolean;
}): {
  readonly confirmsAllAcceptMap: boolean;
  readonly confirmsSplit: false;
  readonly waivesPainCoverage: false;
  readonly confirmsHandoff: false;
} {
  return {
    confirmsAllAcceptMap: input.allAcceptMap && input.leanCarriesOperatorConfirmedSplit,
    confirmsSplit: false,
    waivesPainCoverage: false,
    confirmsHandoff: false,
  };
}

export function bindLeanPredecessorValid(input: {
  readonly predecessorRelievesIds: readonly string[];
  readonly bindRelievesIds: readonly string[];
}): boolean {
  return !input.bindRelievesIds.some((id) => input.predecessorRelievesIds.includes(id));
}

export function evaluateDualStopPostBudget(input: {
  readonly spendSeats: number;
  readonly criticPostsUsed: number;
  readonly operatorRaisedCap: number | null;
  readonly afterHandoff: boolean;
}): {
  readonly numberedCap: number;
  readonly postsRemaining: number;
  readonly refilled: false;
  readonly notation: "posts";
} {
  const base = input.spendSeats === 1 ? 6 : input.spendSeats === 3 ? 3 : 0;
  const numberedCap = input.operatorRaisedCap ?? base;
  const postsUsed = input.afterHandoff ? input.criticPostsUsed : input.criticPostsUsed;
  return {
    numberedCap,
    postsRemaining: Math.max(0, numberedCap - postsUsed),
    refilled: false,
    notation: "posts",
  };
}

export function dualStopCapNotation(posts: number): string {
  return `Dual-stop cap: ${String(posts)} posts`;
}

export function recordingCommentOpensSuccessorLean(body: string): boolean {
  return isSuccessorLeanBody(body);
}
