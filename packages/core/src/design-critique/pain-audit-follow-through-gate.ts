/**
 * Prefer-A Bound #5233: critic-authored pain-audit carrier + accumulated
 * follow-through gate composed into completed-arc pain coverage.
 *
 * Independence clearance (#4442) stays targeting-only. This gate consumes
 * closed finding-classes / harvest-changed plus on-thread harvest identity
 * (Bound-remedy sha256). Retraction/Handoff never clears a rejected harvest.
 * Byte-identical lean rotation does not discharge harvest-changing or blocking.
 */

import { createHash } from "node:crypto";
import { classifyPosition } from "./citation-grammar.js";
import { extractOperativeAuditTargets, painMarkerId } from "./parent-audit.js";

export type PainAuditFindingClass = "blocking" | "sharpening" | "footnote";

export type PainAuditFollowThroughActions = {
  readonly postRetractionThenHandoff: boolean;
  readonly bindableWithoutExtraLean: boolean;
  readonly recordingOnlyParentComment: boolean;
  readonly newBindLeanAndAudit: boolean;
  readonly spendsNumberedDualStopPost: boolean;
  readonly movesCriticEnvelopes: boolean;
  readonly isRelief: boolean;
};

/** Maps critic-authored classes to required parent follow-through (#4593 / #5233). */
export function evaluatePainAuditFollowThrough(input: {
  readonly findingClasses: readonly PainAuditFindingClass[];
  readonly harvestChanged: boolean;
}): PainAuditFollowThroughActions {
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

export type ThreadCommentLike = {
  readonly id: number;
  readonly body: string;
};

const CRITIC_ROLE_RE = /(?:^|\n)\s*role:\s*critic\b/i;
const FINDING_CLASSES_RE = /(?:^|\n)[ \t]*finding-classes:[ \t]*([^\n]*)/gi;
const HARVEST_CHANGED_RE = /(?:^|\n)[ \t]*harvest-changed:[ \t]*([^\n]*)/gi;
const BOUND_REMEDY_HEADING_RE = /(?:^|\n)##[ \t]+Bound remedy\b[ \t]*(?:\r?\n|$)/i;
const NEXT_H2_RE = /\r?\n##[ \t]+/;
const CLASS_TOKEN_RE = /^(blocking|sharpening|footnote|none)$/i;

export type FindingClassesCarrier =
  | {
      readonly ok: true;
      readonly classes: readonly PainAuditFindingClass[];
      readonly explicitEmpty: boolean;
    }
  | { readonly ok: false; readonly detail: string };

export type HarvestChangedCarrier =
  | { readonly ok: true; readonly harvestChanged: boolean }
  | { readonly ok: false; readonly detail: string };

function operativeFieldOffset(match: RegExpMatchArray, token: string): number {
  const offset = match.index ?? 0;
  const inner = match[0].search(new RegExp(token, "i"));
  return offset + (inner >= 0 ? inner : 0);
}

/** Latest operative `finding-classes:` on a critic body, or null when absent. */
export function extractOperativeFindingClasses(body: string): FindingClassesCarrier | null {
  const re = new RegExp(FINDING_CLASSES_RE.source, "gi");
  let lastRaw: string | null = null;
  for (const match of body.matchAll(re)) {
    if (classifyPosition(body, operativeFieldOffset(match, "finding-classes:")) !== null) {
      continue;
    }
    lastRaw = (match[1] ?? "").trim();
  }
  if (lastRaw === null) return null;
  if (lastRaw.length === 0 || /^none$/i.test(lastRaw)) {
    return { ok: true, classes: [], explicitEmpty: true };
  }
  const parts = lastRaw.split(/[, \t]+/).filter((part) => part.length > 0);
  if (parts.length === 0) {
    return { ok: true, classes: [], explicitEmpty: true };
  }
  const classes: PainAuditFindingClass[] = [];
  let sawNone = false;
  for (const part of parts) {
    if (!CLASS_TOKEN_RE.test(part)) {
      return {
        ok: false,
        detail: `finding-classes token '${part}' is not in blocking|sharpening|footnote|none`,
      };
    }
    if (/^none$/i.test(part)) {
      sawNone = true;
      continue;
    }
    const normalized = part.toLowerCase() as PainAuditFindingClass;
    if (!classes.includes(normalized)) classes.push(normalized);
  }
  if (sawNone && classes.length > 0) {
    return {
      ok: false,
      detail: "finding-classes mixes none with other class tokens",
    };
  }
  if (sawNone) {
    return { ok: true, classes: [], explicitEmpty: true };
  }
  return { ok: true, classes, explicitEmpty: false };
}

/** Latest operative `harvest-changed:` boolean, or null when absent. */
export function extractOperativeHarvestChanged(body: string): HarvestChangedCarrier | null {
  const re = new RegExp(HARVEST_CHANGED_RE.source, "gi");
  let lastRaw: string | null = null;
  for (const match of body.matchAll(re)) {
    if (classifyPosition(body, operativeFieldOffset(match, "harvest-changed:")) !== null) {
      continue;
    }
    lastRaw = (match[1] ?? "").trim();
  }
  if (lastRaw === null) return null;
  if (/^true$/i.test(lastRaw)) return { ok: true, harvestChanged: true };
  if (/^false$/i.test(lastRaw)) return { ok: true, harvestChanged: false };
  return {
    ok: false,
    detail: `harvest-changed token '${lastRaw}' is not true|false`,
  };
}

/**
 * Spec-path Bound-remedy harvest identity: sha256 of bytes from the first
 * operative `## Bound remedy` heading through the next H2 or EOF.
 * Empty-string hash when the heading is absent (still a stable identity).
 */
export function hashBoundRemedyBytes(body: string): string {
  const re = new RegExp(BOUND_REMEDY_HEADING_RE.source, "gi");
  for (const match of body.matchAll(re)) {
    const headingOffset = match.index ?? 0;
    const tokenAt = headingOffset + (match[0].startsWith("\n") || match[0].startsWith("\r") ? 1 : 0);
    if (classifyPosition(body, tokenAt) !== null) continue;
    const start = headingOffset + match[0].length;
    const rest = body.slice(start);
    const next = NEXT_H2_RE.exec(rest);
    const slice = next === null ? rest : rest.slice(0, next.index);
    return createHash("sha256").update(slice, "utf8").digest("hex");
  }
  return createHash("sha256").update("", "utf8").digest("hex");
}

export type PainAuditFollowThroughGateResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly detail: string;
      readonly recovery: "retraction-handoff" | "changed-lean-and-later-audit" | "add-carrier";
    };

/**
 * Shared consumer for completed-arc / path-1 / chip / intake (#5233).
 * Accumulates every targeting audit posted while the live lean harvest digest
 * equals the cited lean's Bound-remedy digest. Parent-authored finding-classes
 * lines are ignored (critic-authored only; parent cannot understate).
 */
export function evaluateAccumulatedPainAuditFollowThrough(input: {
  readonly comments: readonly ThreadCommentLike[];
  readonly citedLeanId: number;
  readonly assertedPainIds: readonly string[];
  readonly isSuccessorLeanBody: (body: string) => boolean;
}): PainAuditFollowThroughGateResult {
  const assertedMarkers = new Set(input.assertedPainIds.map(painMarkerId));
  if (assertedMarkers.size === 0) return { ok: true };

  const cited = input.comments.find((comment) => comment.id === input.citedLeanId);
  if (cited === undefined) {
    return {
      ok: false,
      detail:
        "undisposed adverse pain-audit follow-through (cited lean missing for harvest identity)",
      recovery: "changed-lean-and-later-audit",
    };
  }
  const citedHarvestDigest = hashBoundRemedyBytes(cited.body);
  const ordered = [...input.comments].sort((a, b) => a.id - b.id);

  let currentHarvestDigest: string | null = null;
  const targetingOnCitedHarvest: ThreadCommentLike[] = [];

  for (const comment of ordered) {
    if (input.isSuccessorLeanBody(comment.body)) {
      currentHarvestDigest = hashBoundRemedyBytes(comment.body);
      continue;
    }
    if (currentHarvestDigest !== citedHarvestDigest) continue;
    if (!CRITIC_ROLE_RE.test(comment.body)) continue;
    const envelope = extractOperativeAuditTargets(comment.body);
    if (envelope === null || envelope.declaredNone) continue;
    if (!envelope.auditTargets.some((target) => assertedMarkers.has(target))) continue;
    targetingOnCitedHarvest.push(comment);
  }

  for (const audit of targetingOnCitedHarvest) {
    const classesCarrier = extractOperativeFindingClasses(audit.body);
    const harvestCarrier = extractOperativeHarvestChanged(audit.body);
    if (classesCarrier === null || harvestCarrier === null) {
      return {
        ok: false,
        detail:
          "undisposed adverse pain-audit follow-through (missing carrier on targeting audit " +
          String(audit.id) +
          "; require operative finding-classes: and harvest-changed:)",
        recovery: "add-carrier",
      };
    }
    if (!classesCarrier.ok) {
      return {
        ok: false,
        detail:
          "undisposed adverse pain-audit follow-through (malformed finding-classes on audit " +
          String(audit.id) +
          "; " +
          classesCarrier.detail +
          ")",
        recovery: "add-carrier",
      };
    }
    if (!harvestCarrier.ok) {
      return {
        ok: false,
        detail:
          "undisposed adverse pain-audit follow-through (malformed harvest-changed on audit " +
          String(audit.id) +
          "; " +
          harvestCarrier.detail +
          ")",
        recovery: "add-carrier",
      };
    }

    const followThrough = evaluatePainAuditFollowThrough({
      findingClasses: classesCarrier.classes,
      harvestChanged: harvestCarrier.harvestChanged,
    });

    if (followThrough.postRetractionThenHandoff) {
      return {
        ok: false,
        detail:
          "undisposed adverse pain-audit follow-through (blocking audit " +
          String(audit.id) +
          " retires harvest sha256:" +
          citedHarvestDigest.slice(0, 12) +
          "; retraction/Handoff is not clearance; resume needs new Bound-remedy digest + later audit)",
        recovery: "retraction-handoff",
      };
    }
    if (followThrough.newBindLeanAndAudit) {
      return {
        ok: false,
        detail:
          "undisposed adverse pain-audit follow-through (harvest-changing audit " +
          String(audit.id) +
          "; need changed Bound-remedy digest + later independent audit; byte-identical lean rotation does not discharge)",
        recovery: "changed-lean-and-later-audit",
      };
    }
  }

  return { ok: true };
}
