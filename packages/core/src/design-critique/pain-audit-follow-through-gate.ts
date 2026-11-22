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
  matchListItemLine,
  parseListItemsByPosition,
  parseListItemsByPositionFolded,
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
 * Bound-remedy item titles, de-duplicated in list order. With `fold`, each
 * non-blank indented line that is not a list item, directly after an item or
 * that item's previous continuation line, joins the item's title with one
 * space (#7001); a blank line or any other line ends the item. A list line the
 * intake reader opens as an item but `LIST_ITEM_LINE_RE` does not (a bare `-`,
 * or `-x` with no space) counts only when a continuation line folds into it, so
 * no continuation text escapes the digest. Without a continuation line both
 * readings give the same titles.
 */
function boundRemedyTitles(body: string, fold: boolean): string[] {
  // #6265: the same slicer as intake harvest (next H2 or a closed trailer label),
  // so trailer-only lean edits (Reject / Footnotes / takes) do not move the digest.
  const slice = sliceBoundRemedySection(body);
  const rows: { title: string; counts: boolean }[] = [];
  let open: { title: string; counts: boolean } | null = null;
  // Fenced examples inside the remedy are sample text, not limbs (same as intake).
  for (const line of stripFencedCodeBlocks(slice ?? "").split(/\r?\n/)) {
    const item = LIST_ITEM_LINE_RE.exec(line);
    if (item !== null) {
      // Match intake parseListItems: strip leading checkbox markers from titles.
      let title = (item[1] ?? "").trim();
      title = title.replace(CHECKBOX_PREFIX_RE, "").trim();
      open = { title, counts: true };
      rows.push(open);
      continue;
    }
    const intakeItem = fold ? matchListItemLine(line) : null;
    if (intakeItem !== null) {
      open = { title: intakeItem.trim().replace(CHECKBOX_PREFIX_RE, "").trim(), counts: false };
      rows.push(open);
      continue;
    }
    if (fold && open !== null && line.trim().length > 0 && /^[ \t]/.test(line)) {
      const text = line.trim();
      open.title = open.title.length === 0 ? text : `${open.title} ${text}`;
      open.counts = true;
      continue;
    }
    open = null;
  }
  const titles: string[] = [];
  const seen = new Set<string>();
  for (const { title, counts } of rows) {
    if (!counts || title.length === 0 || seen.has(title)) continue;
    seen.add(title);
    titles.push(title);
  }
  return titles;
}

/**
 * Intake-aligned harvest identity: sha256 of Bound-remedy list-item titles
 * (space or hyphen heading), with continuation lines folded into their item
 * (#7001). Trailing `relieves:` / non-list prose is excluded so heading
 * spelling and pain-cite churn cannot launder an unchanged remedy. A remedy
 * with no continuation line keeps its earlier digest. Empty-string hash when
 * the heading or list is absent (still a stable identity).
 */
export function hashBoundRemedyBytes(body: string): string {
  return createHash("sha256")
    .update(boundRemedyTitles(body, true).join("\n"), "utf8")
    .digest("hex");
}

/** True when a lean carries an Acceptance Criteria list or a `## Slices` section (#6333). */
export function leanHasAcceptanceOrSlices(body: string): boolean {
  return leanAcceptanceCriteriaItems(body).length > 0 || leanSlicesSectionLines(body) !== null;
}

function dedupeTitles(items: readonly { readonly title: string }[]): string[] {
  const seen = new Set<string>();
  const titles: string[] = [];
  for (const { title } of items) {
    if (seen.has(title)) continue;
    seen.add(title);
    titles.push(title);
  }
  return titles;
}

function harvestIdentity(body: string, fold: boolean): string {
  const boundDigest = createHash("sha256")
    .update(boundRemedyTitles(body, fold).join("\n"), "utf8")
    .digest("hex");
  if (!leanHasAcceptanceOrSlices(body)) {
    return boundDigest;
  }
  const readPositions = fold ? parseListItemsByPositionFolded : parseListItemsByPosition;
  // Every list position is hashed (repeated titles included), because slice
  // references `B<n>` / `A<n>` count positions: a repeated item that shifts a
  // slice's assignment must move the digest.
  const acPositions = readPositions(
    stripFencedCodeBlocks(sliceLeanAcceptanceCriteriaSection(body) ?? ""),
  );
  const parts = [
    `bound-remedy:${boundDigest}`,
    "bound-remedy-positions:",
    ...readPositions(stripFencedCodeBlocks(sliceBoundRemedySection(body) ?? "")).map(
      (item) => item.title,
    ),
    "acceptance-criteria:",
    ...(fold
      ? dedupeTitles(acPositions)
      : leanAcceptanceCriteriaItems(body).map((item) => item.title)),
    "acceptance-criteria-positions:",
    ...acPositions.map((item) => item.title),
    "slices:",
    ...(leanSlicesSectionLines(body) ?? []),
  ];
  return createHash("sha256").update(parts.join("\n"), "utf8").digest("hex");
}

/**
 * Harvest identity (#6333 item 3): the Bound remedy items, the Acceptance
 * Criteria items and the Slices section, each item with its continuation lines
 * folded in (#7001). A lean with neither of the last two keeps the
 * `hashBoundRemedyBytes` digest, so earlier arcs do not move, and a lean with
 * no continuation line keeps its pre-fold digest.
 */
export function hashHarvestIdentity(body: string): string {
  return harvestIdentity(body, true);
}

/**
 * Harvest identity before continuation lines were folded (#7001): the identity
 * audits recorded before that change carry, and the identity of a criteria-only
 * record, whose item reader does not fold.
 */
export function hashHarvestIdentityPreFold(body: string): string {
  return harvestIdentity(body, false);
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
 * True when an audit's recorded `harvest-digest` is the lean's pre-fold
 * identity and that audit still counts (#7001): the lean has never been edited
 * (its REST `updated_at` equals its `created_at`) and the audit's REST
 * `created_at` is strictly after the lean's `created_at`, so the audit read the
 * only text the lean has had. An unreadable timestamp does not count. For a
 * lean with no continuation line the pre-fold identity is the current identity,
 * which the caller already compares.
 */
export function preFoldDigestAuditCounts(input: {
  readonly recordedDigest: string;
  readonly leanBody: string;
  readonly leanCreatedAt?: unknown;
  readonly leanUpdatedAt?: unknown;
  readonly auditCreatedAt?: unknown;
}): boolean {
  if (input.recordedDigest !== hashHarvestIdentityPreFold(input.leanBody)) return false;
  const created = readUtcInstant(input.leanCreatedAt);
  const updated = readUtcInstant(input.leanUpdatedAt);
  const audit = readUtcInstant(input.auditCreatedAt);
  if (created === null || updated === null || audit === null) return false;
  const unedited =
    !instantIsStrictlyBefore(created, updated) && !instantIsStrictlyBefore(updated, created);
  return unedited && instantIsStrictlyBefore(created, audit);
}

/**
 * An audit counts for a lean only when its recorded digest equals the lean's
 * current harvest identity, or is the lean's pre-fold identity under
 * `preFoldDigestAuditCounts` (#7001). A digestless audit counts for a lean with
 * no Acceptance Criteria list and no Slices section (#6333 item 3). For a lean
 * with either, a digestless audit counts only when the lean's `updated_at` is
 * strictly before the audit's `created_at`, both from the REST rows of those
 * comments (#6477). A present but invalid digest line never counts.
 */
export function auditCountsForLean(input: {
  readonly auditBody: string;
  readonly leanBody: string;
  readonly auditCreatedAt?: unknown;
  readonly leanUpdatedAt?: unknown;
  readonly leanCreatedAt?: unknown;
}): boolean {
  const carrier = extractOperativeHarvestDigest(input.auditBody);
  if (carrier === null) {
    if (!leanHasAcceptanceOrSlices(input.leanBody)) return true;
    return leanUneditedSinceAudit({
      leanUpdatedAt: input.leanUpdatedAt,
      auditCreatedAt: input.auditCreatedAt,
    });
  }
  if (!carrier.ok) return false;
  return (
    carrier.digest === hashHarvestIdentity(input.leanBody) ||
    preFoldDigestAuditCounts({
      recordedDigest: carrier.digest,
      leanBody: input.leanBody,
      leanCreatedAt: input.leanCreatedAt,
      leanUpdatedAt: input.leanUpdatedAt,
      auditCreatedAt: input.auditCreatedAt,
    })
  );
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
  // #7001: the successor lean each audit followed, which is the text it read.
  let currentLean: ThreadCommentLike | null = null;
  const leanBeforeAudit = new Map<number, ThreadCommentLike>();
  const targetingOnCitedHarvest: ThreadCommentLike[] = [];
  const priorHarvestChanging: ThreadCommentLike[] = [];
  let staleOnCitedHarvest = 0;

  for (const comment of ordered) {
    if (input.isSuccessorLeanBody(comment.body)) {
      currentHarvestDigest = hashHarvestIdentity(comment.body);
      currentLean = comment;
      continue;
    }
    if (!CRITIC_ROLE_RE.test(comment.body)) continue;
    const envelope = extractOperativeAuditTargets(comment.body);
    if (envelope === null || envelope.declaredNone) continue;
    if (!envelope.auditTargets.some((target) => assertedMarkers.has(target))) continue;
    if (currentHarvestDigest === citedHarvestDigest) {
      // #6333: an audit that recorded another harvest digest audited an earlier
      // text of this lean; it is not on the cited harvest and does not count.
      // #7001: the pre-fold identity of a never-edited lean is the same text.
      // It is read against the lean the audit followed, not the cited lean, so
      // a byte-identical repost does not turn an earlier audit stale.
      const read = currentLean ?? cited;
      const recorded = extractOperativeHarvestDigest(comment.body);
      if (
        recorded?.ok === true &&
        recorded.digest !== citedHarvestDigest &&
        !preFoldDigestAuditCounts({
          recordedDigest: recorded.digest,
          leanBody: read.body,
          leanCreatedAt: read.created_at,
          leanUpdatedAt: read.updated_at,
          auditCreatedAt: comment.created_at,
        })
      ) {
        staleOnCitedHarvest += 1;
        continue;
      }
      leanBeforeAudit.set(comment.id, read);
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
    const counting = targetingOnCitedHarvest.filter((audit) => {
      if (
        auditCountsForLean({
          auditBody: audit.body,
          leanBody: cited.body,
          auditCreatedAt: audit.created_at,
          leanUpdatedAt: cited.updated_at,
          leanCreatedAt: cited.created_at,
        })
      ) {
        return true;
      }
      // #7001: a pre-fold digest is read against the lean the audit followed.
      const read = leanBeforeAudit.get(audit.id) ?? cited;
      const recorded = extractOperativeHarvestDigest(audit.body);
      return (
        recorded?.ok === true &&
        preFoldDigestAuditCounts({
          recordedDigest: recorded.digest,
          leanBody: read.body,
          leanCreatedAt: read.created_at,
          leanUpdatedAt: read.updated_at,
          auditCreatedAt: audit.created_at,
        })
      );
    });
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
          (hashHarvestIdentityPreFold(cited.body) !== citedHarvestDigest
            ? "; this lean has continuation lines, so an audit carrying its pre-fold digest counts only when the lean's updated_at equals its created_at and the audit's created_at is later"
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
