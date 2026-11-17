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
import {
  leanAcceptanceCriteriaItems,
  leanSlicesSectionLines,
  parseListItemsByPosition,
  sliceBoundRemedySection,
  sliceLeanAcceptanceCriteriaSection,
  stripFencedCodeBlocks,
} from "../intake/markdown-scanners.js";
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
  /** REST `created_at` of the same comment row as `body` (#6477). */
  readonly created_at?: string;
  /** REST `updated_at` of the same comment row as `body` (#6477). */
  readonly updated_at?: string;
};

const CRITIC_ROLE_RE = /(?:^|\n)\s*role:\s*critic\b/i;
const PARENT_ROLE_RE = /(?:^|\n)\s*role:\s*parent\b/i;
const FINDING_CLASSES_RE = /(?:^|\n)[ \t]*finding-classes:[ \t]*([^\n]*)/gi;
const HARVEST_CHANGED_RE = /(?:^|\n)[ \t]*harvest-changed:[ \t]*([^\n]*)/gi;
const CLASS_TOKEN_RE = /^(blocking|sharpening|footnote|none)$/i;
const LIST_ITEM_LINE_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(\S.*)$/;
const CHECKBOX_PREFIX_RE = /^\[[ xX]\][ \t]+/;
const RECORDING_TAKES_RE = /(?:^|\n)[ \t]*(?:takes?|per-heading takes|recorded takes)\b/i;

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

function parseFindingClassesRaw(raw: string): FindingClassesCarrier {
  const lastRaw = raw.trim();
  if (lastRaw.length === 0) {
    return {
      ok: false,
      detail: "finding-classes blank requires explicit none",
    };
  }
  if (/^none$/i.test(lastRaw)) {
    return { ok: true, classes: [], explicitEmpty: true };
  }
  const parts = lastRaw.split(/[, \t]+/).filter((part) => part.length > 0);
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

function findingClassesFingerprint(carrier: Extract<FindingClassesCarrier, { ok: true }>): string {
  return `${carrier.explicitEmpty ? "none" : "set"}:${[...carrier.classes].sort().join(",")}`;
}

/** Operative `finding-classes:` carrier; conflicting declarations refuse. */
export function extractOperativeFindingClasses(body: string): FindingClassesCarrier | null {
  const re = new RegExp(FINDING_CLASSES_RE.source, "gi");
  const parsed: FindingClassesCarrier[] = [];
  for (const match of body.matchAll(re)) {
    if (classifyPosition(body, operativeFieldOffset(match, "finding-classes:")) !== null) {
      continue;
    }
    parsed.push(parseFindingClassesRaw(match[1] ?? ""));
  }
  if (parsed.length === 0) return null;
  for (const carrier of parsed) {
    if (!carrier.ok) return carrier;
  }
  const okCarriers = parsed as Array<Extract<FindingClassesCarrier, { ok: true }>>;
  const first = okCarriers[0];
  if (first === undefined) return null;
  const fingerprint = findingClassesFingerprint(first);
  for (const carrier of okCarriers.slice(1)) {
    if (findingClassesFingerprint(carrier) !== fingerprint) {
      return {
        ok: false,
        detail: "finding-classes declarations conflict across operative lines",
      };
    }
  }
  return first;
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
 * Intake-aligned harvest identity: sha256 of Bound-remedy list-item titles
 * (space or hyphen heading). Trailing `relieves:` / non-list prose is excluded
 * so heading spelling and pain-cite churn cannot launder an unchanged remedy.
 * Empty-string hash when the heading or list is absent (still a stable identity).
 */
export function hashBoundRemedyBytes(body: string): string {
  // #6265: the same slicer as intake harvest (next H2 or a closed trailer label),
  // so trailer-only lean edits (Reject / Footnotes / takes) do not move the digest.
  const slice = sliceBoundRemedySection(body);
  const titles: string[] = [];
  const seen = new Set<string>();
  // Fenced examples inside the remedy are sample text, not limbs (same as intake).
  for (const line of stripFencedCodeBlocks(slice ?? "").split(/\r?\n/)) {
    const item = LIST_ITEM_LINE_RE.exec(line);
    if (item === null) continue;
    // Match intake parseListItems: strip leading checkbox markers from titles.
    let title = (item[1] ?? "").trim();
    title = title.replace(CHECKBOX_PREFIX_RE, "").trim();
    if (title.length === 0 || seen.has(title)) continue;
    seen.add(title);
    titles.push(title);
  }
  return createHash("sha256").update(titles.join("\n"), "utf8").digest("hex");
}

/** True when a lean carries an Acceptance Criteria list or a `## Slices` section (#6333). */
export function leanHasAcceptanceOrSlices(body: string): boolean {
  return leanAcceptanceCriteriaItems(body).length > 0 || leanSlicesSectionLines(body) !== null;
}

/**
 * Harvest identity (#6333 item 3): the Bound remedy items, the Acceptance
 * Criteria items and the Slices section. A lean with neither of the last two
 * keeps the `hashBoundRemedyBytes` digest, so earlier arcs do not move.
 */
export function hashHarvestIdentity(body: string): string {
  if (!leanHasAcceptanceOrSlices(body)) {
    return hashBoundRemedyBytes(body);
  }
  // Every list position is hashed (repeated titles included), because slice
  // references `B<n>` / `A<n>` count positions: a repeated item that shifts a
  // slice's assignment must move the digest.
  const acSlice = sliceLeanAcceptanceCriteriaSection(body);
  const parts = [
    `bound-remedy:${hashBoundRemedyBytes(body)}`,
    "bound-remedy-positions:",
    ...parseListItemsByPosition(stripFencedCodeBlocks(sliceBoundRemedySection(body) ?? "")).map(
      (item) => item.title,
    ),
    "acceptance-criteria:",
    ...leanAcceptanceCriteriaItems(body).map((item) => item.title),
    "acceptance-criteria-positions:",
    ...parseListItemsByPosition(stripFencedCodeBlocks(acSlice ?? "")).map((item) => item.title),
    "slices:",
    ...(leanSlicesSectionLines(body) ?? []),
  ];
  return createHash("sha256").update(parts.join("\n"), "utf8").digest("hex");
}

const HARVEST_DIGEST_RE = /(?:^|\n)[ \t]*harvest-digest:[ \t]*([^\n]*)/gi;

export type HarvestDigestCarrier =
  | { readonly ok: true; readonly digest: string }
  | { readonly ok: false; readonly detail: string };

/**
 * Operative `harvest-digest:` line on a critic post (#6333), as lowercase hex
 * without the `sha256:` prefix. Null when absent; conflicting lines refuse.
 */
export function extractOperativeHarvestDigest(body: string): HarvestDigestCarrier | null {
  const re = new RegExp(HARVEST_DIGEST_RE.source, "gi");
  const seen = new Set<string>();
  for (const match of body.matchAll(re)) {
    if (classifyPosition(body, operativeFieldOffset(match, "harvest-digest:")) !== null) {
      continue;
    }
    const raw = (match[1] ?? "").trim().toLowerCase();
    seen.add(raw.startsWith("sha256:") ? raw.slice("sha256:".length).trim() : raw);
  }
  if (seen.size === 0) return null;
  if (seen.size > 1) {
    return { ok: false, detail: "harvest-digest declarations conflict across operative lines" };
  }
  const digest = [...seen][0] ?? "";
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    return { ok: false, detail: "harvest-digest is not sha256: plus 64 lowercase hex digits" };
  }
  return { ok: true, digest };
}

const UTC_INSTANT_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/;

type UtcInstant = { readonly seconds: string; readonly fraction: string };

/**
 * A GitHub REST comment instant: `YYYY-MM-DDTHH:MM:SS`, an optional fraction,
 * and a trailing `Z`. Anything else (missing, empty, null, non-string, another
 * shape, or a calendar roll-over such as `2026-02-30`) is unreadable (#6477).
 */
function readUtcInstant(value: unknown): UtcInstant | null {
  if (typeof value !== "string") return null;
  const match = UTC_INSTANT_RE.exec(value);
  if (match === null) return null;
  const seconds = match[1] ?? "";
  const parsed = Date.parse(`${seconds}Z`);
  if (Number.isNaN(parsed) || !new Date(parsed).toISOString().startsWith(seconds)) return null;
  return { seconds, fraction: match[2] ?? "" };
}

/** Exact order of two readable instants; equal is not before. */
function instantIsStrictlyBefore(a: UtcInstant, b: UtcInstant): boolean {
  if (a.seconds !== b.seconds) return a.seconds < b.seconds;
  const width = Math.max(a.fraction.length, b.fraction.length);
  return a.fraction.padEnd(width, "0") < b.fraction.padEnd(width, "0");
}

/**
 * True only when both instants are readable and the lean's `updated_at` is
 * strictly before the audit's `created_at`: the lean was not edited after the
 * audit, so its harvest is the one the audit read (#6477).
 */
export function leanUneditedSinceAudit(input: {
  readonly leanUpdatedAt: unknown;
  readonly auditCreatedAt: unknown;
}): boolean {
  const lean = readUtcInstant(input.leanUpdatedAt);
  const audit = readUtcInstant(input.auditCreatedAt);
  return lean !== null && audit !== null && instantIsStrictlyBefore(lean, audit);
}

/**
 * An audit counts for a lean only when its recorded digest equals the lean's
 * current harvest identity. A digestless audit counts for a lean with no
 * Acceptance Criteria list and no Slices section (#6333 item 3). For a lean
 * with either, a digestless audit counts only when the lean's `updated_at` is
 * strictly before the audit's `created_at`, both from the REST rows of those
 * comments (#6477). A present but invalid digest line never counts.
 */
export function auditCountsForLean(input: {
  readonly auditBody: string;
  readonly leanBody: string;
  readonly auditCreatedAt?: unknown;
  readonly leanUpdatedAt?: unknown;
}): boolean {
  const carrier = extractOperativeHarvestDigest(input.auditBody);
  if (carrier === null) {
    if (!leanHasAcceptanceOrSlices(input.leanBody)) return true;
    return leanUneditedSinceAudit({
      leanUpdatedAt: input.leanUpdatedAt,
      auditCreatedAt: input.auditCreatedAt,
    });
  }
  return carrier.ok && carrier.digest === hashHarvestIdentity(input.leanBody);
}

function commentCitesId(body: string, id: number): boolean {
  return new RegExp(`(?:^|\\D)${String(id)}(?:\\D|$)`).test(body);
}

function hasRecordingParentTakes(
  comments: readonly ThreadCommentLike[],
  auditId: number,
  isSuccessorLeanBody: (body: string) => boolean,
): boolean {
  return comments.some((comment) => {
    if (comment.id <= auditId) return false;
    if (!PARENT_ROLE_RE.test(comment.body)) return false;
    if (isSuccessorLeanBody(comment.body)) return false;
    // Bare numeric cite alone is not disposition; require takes language.
    return RECORDING_TAKES_RE.test(comment.body) && commentCitesId(comment.body, auditId);
  });
}

export type PainAuditFollowThroughGateResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly detail: string;
      readonly recovery:
        | "retraction-handoff"
        | "changed-lean-and-later-audit"
        | "add-carrier"
        | "record-parent-takes";
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
  const citedHarvestDigest = hashHarvestIdentity(cited.body);
  const ordered = [...input.comments].sort((a, b) => a.id - b.id);

  let currentHarvestDigest: string | null = null;
  const targetingOnCitedHarvest: ThreadCommentLike[] = [];
  const priorHarvestChanging: ThreadCommentLike[] = [];
  let staleOnCitedHarvest = 0;

  for (const comment of ordered) {
    if (input.isSuccessorLeanBody(comment.body)) {
      currentHarvestDigest = hashHarvestIdentity(comment.body);
      continue;
    }
    if (!CRITIC_ROLE_RE.test(comment.body)) continue;
    const envelope = extractOperativeAuditTargets(comment.body);
    if (envelope === null || envelope.declaredNone) continue;
    if (!envelope.auditTargets.some((target) => assertedMarkers.has(target))) continue;
    if (currentHarvestDigest === citedHarvestDigest) {
      // #6333: an audit that recorded another harvest digest audited an earlier
      // text of this lean; it is not on the cited harvest and does not count.
      const recorded = extractOperativeHarvestDigest(comment.body);
      if (recorded?.ok === true && recorded.digest !== citedHarvestDigest) {
        staleOnCitedHarvest += 1;
        continue;
      }
      targetingOnCitedHarvest.push(comment);
      continue;
    }
    // Prior harvests: remember harvest-changing audits the cited lean must dispose.
    if (comment.id >= input.citedLeanId) continue;
    if (currentHarvestDigest === null) continue;
    const harvestCarrier = extractOperativeHarvestChanged(comment.body);
    const classesCarrier = extractOperativeFindingClasses(comment.body);
    if (
      harvestCarrier?.ok === true &&
      harvestCarrier.harvestChanged &&
      classesCarrier?.ok === true
    ) {
      const followThrough = evaluatePainAuditFollowThrough({
        findingClasses: classesCarrier.classes,
        harvestChanged: true,
      });
      if (followThrough.newBindLeanAndAudit) {
        priorHarvestChanging.push(comment);
      }
    }
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
    if (followThrough.recordingOnlyParentComment) {
      if (!hasRecordingParentTakes(ordered, audit.id, input.isSuccessorLeanBody)) {
        return {
          ok: false,
          detail:
            "undisposed adverse pain-audit follow-through (non-harvest sharpening audit " +
            String(audit.id) +
            "; require parent comment recording takes that does not open as a successor lean)",
          recovery: "record-parent-takes",
        };
      }
    }
  }

  // #6333 item 3: at least one targeting audit must count for this lean.
  const leanNeedsDigest = leanHasAcceptanceOrSlices(cited.body);
  if (leanNeedsDigest || targetingOnCitedHarvest.length > 0 || staleOnCitedHarvest > 0) {
    const counting = targetingOnCitedHarvest.filter((audit) =>
      auditCountsForLean({
        auditBody: audit.body,
        leanBody: cited.body,
        auditCreatedAt: audit.created_at,
        leanUpdatedAt: cited.updated_at,
      }),
    );
    if (counting.length === 0) {
      return {
        ok: false,
        detail:
          "undisposed adverse pain-audit follow-through (no targeting audit counts for lean " +
          String(cited.id) +
          "; an audit counts only when its operative harvest-digest: line equals the lean's current harvest digest" +
          (leanNeedsDigest
            ? ", and this lean carries an Acceptance Criteria list or a Slices section so a digestless audit counts only when the lean's updated_at is strictly before the audit's created_at"
            : "") +
          "; expected harvest-digest: sha256:" +
          citedHarvestDigest +
          ")",
        recovery: "add-carrier",
      };
    }
  }

  for (const prior of priorHarvestChanging) {
    if (!commentCitesId(cited.body, prior.id)) {
      return {
        ok: false,
        detail:
          "undisposed adverse pain-audit follow-through (changed Bound-remedy digest after harvest-changing audit " +
          String(prior.id) +
          "; cited lean must cite/dispose that critic finding; byte inequality alone is not disposition)",
        recovery: "changed-lean-and-later-audit",
      };
    }
  }

  return { ok: true };
}
