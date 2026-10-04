/**
 * Yolo leftover-pain handling (#4593): split/defer/deliver recipe, Dual-stop
 * posts-not-seats, and pain-audit follow-through after a bind lean.
 *
 * Does not NLP-grade Bound-remedy English (ADR-005). Does not waive #4592
 * path-1 refuse. Pain-audit dispatch fills operative audit-targets (ids or
 * none). English Pain-audit headings are not targeting. Parent calls
 * evaluateAutoStampPath1Write before path-1. Footnote-only follow-through
 * is not clearance (#4648). #5233 composes evaluatePainAuditFollowThrough
 * into completed-arc via evaluateAccumulatedPainAuditFollowThrough.
 *
 * #5188 recording helpers: reserved-slot literacy (`dual-stop-reserved:`) and
 * process-only `verification-path:` before panel-deposit. Returned refusals
 * only; no Dual-stop math recut and no always-on +1.
 */

import { type PainCite, scanPainCites } from "./citation-grammar.js";
import {
  criticEnvelopes,
  isSuccessorLeanBody,
  latestCancelled,
  type ThreadComment,
} from "./completed-arc-record.js";
import { evaluateDualStopReservedSlot } from "./handoff.js";
import {
  evaluatePainAuditFollowThrough,
  type PainAuditFindingClass,
} from "./pain-audit-follow-through-gate.js";
import { extractOperativeAuditTargets, painMarkerId } from "./parent-audit.js";
import { type ArcSpend, N3_SPEND } from "./spend.js";

export type { PainAuditFindingClass };
export { evaluatePainAuditFollowThrough };

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

/**
 * Same asserted set applyPainCoverage uses: relieves plus different-issue
 * deferred. Those stay unresolved ADR-006 markers until a later critic
 * targets them. Stale buildPainCoverageDeposit JSDoc (relief cites "are not
 * this bind") does not recut this conjunct (#4648).
 */
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
  const lastHeading = input.primaryBlockingHeadings[input.primaryBlockingHeadings.length - 1];
  const prevHeading = input.primaryBlockingHeadings[input.primaryBlockingHeadings.length - 2];
  const haltOnRepeatPrimary =
    typeof lastHeading === "string" && lastHeading.length > 0 && lastHeading === prevHeading;
  const strictlyFewerEachAudit = input.blockingCounts.every((curr, i, counts) => {
    if (i === 0) return true;
    const prev = counts[i - 1];
    return prev !== undefined && curr < prev;
  });
  return {
    finishStillPossible: strictlyFewerEachAudit && !haltOnRepeatPrimary,
    haltOnRepeatPrimary,
  };
}

export function evaluateBoundRemedyCites(input: {
  readonly unmetIds: readonly string[];
  readonly coveredIds: readonly string[];
  readonly cites: readonly PainCite[];
  readonly issueNumber?: number;
}): { readonly ok: boolean } {
  for (const cite of input.cites) {
    if (cite.disposition === "operator-deferred") {
      if (!input.unmetIds.includes(cite.painId)) {
        return { ok: false };
      }
      if (cite.deferredIssueNumber === null) {
        return { ok: false };
      }
      if (input.issueNumber !== undefined && cite.deferredIssueNumber === input.issueNumber) {
        return { ok: false };
      }
      continue;
    }
    if (cite.disposition === "relieves" && !input.coveredIds.includes(cite.painId)) {
      return { ok: false };
    }
  }
  return { ok: true };
}

/** Operative line-start for pain-audit dispatch. Marker ids, or none. */
export function painAuditDispatchAuditTargetsLine(markerIds: readonly string[]): string {
  if (markerIds.length === 0) return "audit-targets: none";
  return `audit-targets: ${markerIds.join(", ")}`;
}

/**
 * Pain-audit dispatch fill: criticEnvelopes reads extractOperativeAuditTargets
 * only. English Pain-audit headings are not targeting. none is not fill when
 * marker ids are required.
 */
export function evaluatePainAuditDispatchFill(input: {
  readonly body: string;
  readonly requiredMarkerIds: readonly string[];
}): { readonly filled: boolean } {
  const envelope = extractOperativeAuditTargets(input.body);
  if (envelope === null) return { filled: false };
  if (input.requiredMarkerIds.length === 0) {
    return { filled: envelope.declaredNone };
  }
  if (envelope.declaredNone) return { filled: false };
  const have = new Set(envelope.auditTargets);
  return { filled: input.requiredMarkerIds.every((id) => have.has(id)) };
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

/**
 * Bind lean must name a predecessor that does not already carry relieves of
 * those ids. Escape (#5284): overlap allowed only when harvestChanged and the
 * bind map operatively Recut-supersedes a prior successor lean
 * (`collectSupersededSuccessorLeans` / operative supersedes cite).
 */
export function bindLeanPredecessorValid(input: {
  readonly predecessorRelievesIds: readonly string[];
  readonly bindRelievesIds: readonly string[];
  /** Same boolean threaded by evaluatePainAuditFollowThrough. */
  readonly harvestChanged?: boolean;
  /** True when collectSupersededSuccessorLeans finds an operative prior successor lean. */
  readonly operativelyRecutSupersedesPriorSuccessorLean?: boolean;
}): boolean {
  const overlap = input.bindRelievesIds.some((id) => input.predecessorRelievesIds.includes(id));
  if (!overlap) return true;
  if (
    input.harvestChanged === true &&
    input.operativelyRecutSupersedesPriorSuccessorLean === true
  ) {
    return true;
  }
  return false;
}

/**
 * Map used spend permission to Dual-stop spendSeats (#4705).
 * N≥3 is 3. N=1 is 1. N>3 stays unaddressed (evaluateDualStopPostBudget
 * numberedCap 0 for any other spendSeats).
 */
export function dualStopSpendSeats(spend: "N=1" | "N≥3"): 1 | 3 {
  return spend === "N≥3" ? 3 : 1;
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

/**
 * Reserved-slot use from critic envelopes after the earliest asserted-coverage
 * successor lean. Filter auditTargets to painMarkerId of asserted ids. Do not
 * use declaredNone or .length. Do not reset on a later Recut-supersedes lean.
 * Stop the search and audit count at the current arc's cancelled boundary.
 */
export function deriveReservedPainAuditPostsUsed(input: {
  readonly comments: readonly ThreadComment[];
  readonly afterCommentId: number;
  readonly assertedPainIds: readonly string[];
}): number {
  const markers = new Set(input.assertedPainIds.map(painMarkerId));
  const cancel = latestCancelled(
    input.comments.filter((comment) => comment.id < input.afterCommentId),
  );
  const cancelId = cancel?.id;
  let afterCommentId = input.afterCommentId;
  for (const comment of input.comments) {
    if (comment.id >= afterCommentId) continue;
    if (cancelId !== undefined && comment.id <= cancelId) continue;
    if (!isSuccessorLeanBody(comment.body)) continue;
    if (!mapCarriesAssertedPainCoverage(comment.body, input.assertedPainIds, undefined)) {
      continue;
    }
    afterCommentId = comment.id;
  }
  return criticEnvelopes(input.comments, afterCommentId).filter((envelope) =>
    envelope.auditTargets.some((target) => markers.has(target)),
  ).length;
}

export type DualStopParentPathVerdict = {
  readonly postsRemaining: number;
  readonly inCapWithoutRaise: boolean;
  readonly admit: boolean;
};

/**
 * Parent-facing Dual-stop: numbered remaining OR the existing reserved slot.
 * Does not fold reserved into numbered postsRemaining.
 */
export function evaluateDualStopParentPath(input: {
  readonly spendSeats: number;
  readonly criticPostsUsed: number;
  readonly operatorRaisedCap: number | null;
  readonly afterHandoff: boolean;
  readonly mapCarriesAssertedPainCoverage: boolean;
  readonly reservedPainAuditPostsUsed: number;
}): DualStopParentPathVerdict {
  const budget = evaluateDualStopPostBudget({
    spendSeats: input.spendSeats,
    criticPostsUsed: input.criticPostsUsed,
    operatorRaisedCap: input.operatorRaisedCap,
    afterHandoff: input.afterHandoff,
  });
  const reserved = evaluateDualStopReservedSlot({
    numberedCap: budget.numberedCap,
    criticPostsUsed: input.criticPostsUsed,
    mapCarriesAssertedPainCoverage: input.mapCarriesAssertedPainCoverage,
    reservedPainAuditPostsUsed: input.reservedPainAuditPostsUsed,
    operatorRaisedCap: input.operatorRaisedCap !== null,
  });
  return {
    postsRemaining: budget.postsRemaining,
    inCapWithoutRaise: reserved.inCapWithoutRaise,
    admit: budget.postsRemaining > 0 || reserved.inCapWithoutRaise,
  };
}

export function dualStopCapNotation(posts: number): string {
  return `Dual-stop cap: ${String(posts)} posts`;
}

export function recordingCommentOpensSuccessorLean(body: string): boolean {
  return isSuccessorLeanBody(body);
}

/** Closed Stop 1 / parent literacy line when spend is N≥3 and pain is non-vacuous (#5188). */
export const DUAL_STOP_RESERVED_LITERACY_FIELD = "dual-stop-reserved:";

export function dualStopReservedLiteracyRecordLine(): string {
  return (
    `${DUAL_STOP_RESERVED_LITERACY_FIELD} first post-lean pain-audit of asserted ` +
    "coverage in-cap via evaluateDualStopParentPath; raise after reserved spent"
  );
}

/**
 * Whether Stop 1 / parent must surface Dual-stop reserved-slot literacy.
 * Reuses existing N≥3 spend token and pain ids; does not grow numbered budget
 * or key a second reserved-slot predicate off Stop 1 pain presence.
 */
export function evaluateReservedSlotLiteracyRecording(input: {
  readonly spend: ArcSpend | null;
  readonly painIds: readonly string[];
}): { readonly owed: boolean; readonly recordLine: string | null } {
  const nonVacuous = input.painIds.some((id) => /^P\d{1,8}$/.test(id));
  const owed = input.spend === N3_SPEND && nonVacuous;
  return {
    owed,
    recordLine: owed ? dualStopReservedLiteracyRecordLine() : null,
  };
}

/** Closed verification-path line before panel-deposit on a process-only dest (#5188). */
export const VERIFICATION_PATH_FIELD = "verification-path:";

export type VerificationPathRecord =
  | { readonly kind: "pin-read"; readonly dispatchSha: string }
  | { readonly kind: "provisioned"; readonly path: string };

export function verificationPathRecordLine(input: VerificationPathRecord): string {
  if (input.kind === "pin-read") {
    return (
      `${VERIFICATION_PATH_FIELD} pin-read git show ${input.dispatchSha}:; ` +
      "dest cwd-without-occupy"
    );
  }
  return `${VERIFICATION_PATH_FIELD} provisioned ${input.path}`;
}

/** Closed forms only — matches `verificationPathRecordLine` output. */
const VERIFICATION_PATH_CLOSED_RE = /^verification-path:\s+(?:pin-read|provisioned)\s+\S/;
const VERIFICATION_PATH_ANY_RE = /^verification-path:\s+\S/;

/**
 * Fixture over parent-claimed process-only dest + recorded line.
 * Accepts only closed `pin-read` / `provisioned` lines from
 * `verificationPathRecordLine`. Launch-probe and other junk →
 * `invalid-verification-path`. Returned refusal only — no throw.
 */
export function evaluateVerificationPathBeforePanelDeposit(input: {
  readonly processOnlyDest: boolean;
  readonly recordedLine: string | null;
}):
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "missing-verification-path" | "invalid-verification-path";
    } {
  if (!input.processOnlyDest) {
    return { ok: true };
  }
  const line = input.recordedLine?.trim() ?? "";
  if (VERIFICATION_PATH_CLOSED_RE.test(line)) {
    return { ok: true };
  }
  if (VERIFICATION_PATH_ANY_RE.test(line)) {
    return { ok: false, reason: "invalid-verification-path" };
  }
  return { ok: false, reason: "missing-verification-path" };
}
