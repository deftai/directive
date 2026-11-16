/**
 * Linear-time markdown scanners for issue body parsing (#1784 / #1248).
 * Avoids nested/polynomial regex on issue bodies (ReDoS-safe).
 */

import { classifyPosition } from "../design-critique/citation-grammar.js";

/** Strip fenced code blocks only (preserves inline backtick spans). */
export function stripFencedCodeBlocks(body: string): string {
  if (body.length === 0) {
    return "";
  }
  return stripFencedCodeBlocksInner(body);
}

/** Strip fenced and inline code spans before cross-ref extraction. */
export function stripCodeBlocks(body: string): string {
  if (body.length === 0) {
    return "";
  }
  let text = stripFencedCodeBlocksInner(body);
  text = stripInlineCode(text);
  return text;
}

function stripFencedCodeBlocksInner(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const fence = detectFenceOpen(text, i);
    if (fence === null) {
      out += text[i];
      i += 1;
      continue;
    }
    const close = findFenceClose(text, fence.end, fence.delimiter);
    i = close >= 0 ? close : text.length;
  }
  return out;
}

function detectFenceOpen(text: string, index: number): { delimiter: string; end: number } | null {
  if (text.startsWith("```", index)) {
    return { delimiter: "```", end: index + 3 };
  }
  if (text.startsWith("~~~", index)) {
    return { delimiter: "~~~", end: index + 3 };
  }
  return null;
}

function findFenceClose(text: string, start: number, delimiter: string): number {
  let i = start;
  while (i < text.length) {
    if (text.startsWith(delimiter, i)) {
      return i + delimiter.length;
    }
    i += 1;
  }
  return -1;
}

function stripInlineCode(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end < 0 || text.slice(i + 1, end).includes("\n")) {
        out += text[i];
        i += 1;
        continue;
      }
      i = end + 1;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

export interface CheckboxItem {
  readonly title: string;
  readonly status: "proposed" | "completed";
}

/** Parse GitHub-flavoured task-list checkboxes line-by-line. */
export function parseCheckboxItems(text: string): CheckboxItem[] {
  const items: CheckboxItem[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const match = matchCheckboxLine(line);
    if (match === null) {
      continue;
    }
    const title = match.title.trim();
    if (title.length === 0 || seen.has(title)) {
      continue;
    }
    seen.add(title);
    items.push({
      title,
      status: match.checked ? "completed" : "proposed",
    });
  }
  return items;
}

function matchCheckboxLine(line: string): { checked: boolean; title: string } | null {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) {
    i += 1;
  }
  if (i >= line.length || !"-*+".includes(line[i] as string)) {
    return null;
  }
  i += 1;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) {
    i += 1;
  }
  if (!line.startsWith("[", i)) {
    return null;
  }
  const close = line.indexOf("]", i + 1);
  if (close < 0) {
    return null;
  }
  const marker = line.slice(i + 1, close);
  if (marker !== " " && marker !== "x" && marker !== "X") {
    return null;
  }
  let rest = line.slice(close + 1);
  if (rest.startsWith(" ")) {
    rest = rest.slice(1);
  }
  rest = rest.trimEnd();
  return { checked: marker.toLowerCase() === "x", title: rest };
}

export interface AcHeadingMatch {
  readonly level: number;
  readonly sectionStart: number;
}

/** Find an Acceptance Criteria heading (case-insensitive). */
export function findAcHeading(text: string): AcHeadingMatch | null {
  let offset = 0;
  for (const line of text.split("\n")) {
    const match = matchAcHeadingLine(line);
    if (match !== null) {
      return { level: match.level, sectionStart: offset + match.end };
    }
    offset += line.length + 1;
  }
  return null;
}

function matchAcHeadingLine(line: string): { level: number; end: number } | null {
  if (!line.startsWith("#")) {
    return null;
  }
  let level = 0;
  while (level < line.length && line[level] === "#") {
    level += 1;
  }
  if (level < 1 || level > 6) {
    return null;
  }
  if (level >= line.length || line[level] !== " ") {
    return null;
  }
  const headingText = line
    .slice(level + 1)
    .trim()
    .toLowerCase();
  if (!/\bacceptance\s+criteria\b/.test(headingText)) {
    return null;
  }
  return { level, end: line.length };
}

const BOUND_REMEDY_HEADING_RE = /^bound[\s-]+remedy\b/;

/** Find a Lean-family Bound-remedy heading (same class as In plain English). */
export function findBoundRemedyHeading(text: string): AcHeadingMatch | null {
  let offset = 0;
  for (const line of text.split("\n")) {
    const match = matchBoundRemedyHeadingLine(line);
    if (match !== null && classifyPosition(text, offset) === null) {
      return { level: match.level, sectionStart: offset + match.end };
    }
    offset += line.length + 1;
  }
  return null;
}

function matchBoundRemedyHeadingLine(line: string): { level: number; end: number } | null {
  if (!line.startsWith("#")) {
    return null;
  }
  let level = 0;
  while (level < line.length && line[level] === "#") {
    level += 1;
  }
  if (level !== 2) {
    return null;
  }
  if (level >= line.length || line[level] !== " ") {
    return null;
  }
  const headingText = line
    .slice(level + 1)
    .trim()
    .toLowerCase();
  if (!BOUND_REMEDY_HEADING_RE.test(headingText)) {
    return null;
  }
  return { level, end: line.length };
}

/**
 * Closed trailer set that ends a Bound-remedy slice (#6265). Whole-line, non-list
 * label with an optional parenthesised qualifier before the colon, e.g.
 * `Reject:` / `Footnotes (dispose-as-footnote):` / `takes:`. Closed on purpose: an
 * open colon-label cut would drop real limbs after a `Cases:` intro (#6265 F1).
 */
const LEAN_TRAILER_LABEL_RE =
  /^(reject|not proposed|footnotes?|takes|residual|notes|coordination)(?:\s*\([^()\n]*\))?\s*:$/i;
/** Trailers whose list lines are must-not text (`plan.narratives.Constraint`). */
const LEAN_CONSTRAINT_LABEL_RE = /^(reject|not proposed)(?:\s*\([^()\n]*\))?\s*:?$/i;
const LEAN_TRAILER_HEADING_RE =
  /^(reject|not proposed|footnotes?|takes|residual|notes|coordination)(?:\s*\([^()\n]*\))?\s*:?$/i;

function stripBoldMarkers(text: string): string {
  return text.replace(/\*\*|__/g, "").trim();
}

/** ATX heading text (no hashes), or null when the line is not a heading. */
function atxHeadingText(line: string): string | null {
  if (!isAtxHeadingLine(line)) {
    return null;
  }
  return line
    .trim()
    .replace(/^#{1,6}/, "")
    .replace(/\s#+\s*$/, "")
    .trim();
}

/** Whole-line non-list trailer label or a heading whose text is a trailer (#6265). */
function isLeanTrailerLine(line: string): boolean {
  const trimmed = line.trim();
  // `**Reject:**` starts with `*` but is a bold label, not a list item.
  if (trimmed.startsWith("**") || trimmed.startsWith("__")) {
    return LEAN_TRAILER_LABEL_RE.test(stripBoldMarkers(trimmed));
  }
  if (matchListItemLine(line) !== null) {
    return false;
  }
  const heading = atxHeadingText(line);
  if (heading !== null) {
    return LEAN_TRAILER_HEADING_RE.test(stripBoldMarkers(heading));
  }
  return LEAN_TRAILER_LABEL_RE.test(stripBoldMarkers(line.trim()));
}

/**
 * Bound-remedy slice (#6265): from the `## Bound remedy` heading to the next
 * heading of level 2 or higher, or the first closed trailer label. One slicer for
 * intake harvest and `hashBoundRemedyBytes`. Null when the heading is absent.
 */
export function sliceBoundRemedySection(text: string): string | null {
  if (text.length === 0) {
    return null;
  }
  const heading = findBoundRemedyHeading(text);
  if (heading === null) {
    return null;
  }
  return sliceLeanSection(text, heading);
}

/**
 * One lean-section slicer (#6265 / #6333): from the heading to the next heading
 * of the same or higher level, or the first closed trailer label, outside fences.
 */
function sliceLeanSection(text: string, heading: AcHeadingMatch): string {
  const section = text.slice(heading.sectionStart);
  let offset = 0;
  let fenced = false;
  for (const line of section.split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      // A heading or trailer label inside a fenced example is sample text.
      fenced = !fenced;
    } else if (
      !fenced &&
      offset > 0 &&
      (isHeadingAtOrAbove(line, heading.level) || isLeanTrailerLine(line))
    ) {
      return section.slice(0, offset);
    }
    offset += line.length + 1;
  }
  return section;
}

/** Level-2 lean heading whose text matches `re`, outside fences, quotes and code (#6333). */
function findLeanLevel2Heading(text: string, re: RegExp): AcHeadingMatch | null {
  let offset = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (trimmed.startsWith("## ") && classifyPosition(text, offset) === null) {
      const headingText = trimmed.slice(3).trim().toLowerCase();
      if (re.test(headingText)) {
        return { level: 2, sectionStart: offset + line.length };
      }
    }
    offset += line.length + 1;
  }
  return null;
}

const LEAN_AC_HEADING_RE = /^acceptance\s+criteria\b/;
const LEAN_SLICES_HEADING_RE = /^slices\b/;

/**
 * Lean `## Acceptance Criteria` heading (#6333 item 1): matched like the Bound
 * remedy heading (level 2, position-aware, fence-aware).
 */
export function findLeanAcceptanceCriteriaHeading(text: string): AcHeadingMatch | null {
  return text.length === 0 ? null : findLeanLevel2Heading(text, LEAN_AC_HEADING_RE);
}

/** Lean Acceptance Criteria slice, or null when the heading is absent (#6333). */
export function sliceLeanAcceptanceCriteriaSection(text: string): string | null {
  const heading = findLeanAcceptanceCriteriaHeading(text);
  return heading === null ? null : sliceLeanSection(text, heading);
}

/** Lean Acceptance Criteria list items, outside fenced examples (#6333). */
export function leanAcceptanceCriteriaItems(text: string): CheckboxItem[] {
  const slice = sliceLeanAcceptanceCriteriaSection(text);
  return slice === null ? [] : parseListItems(stripFencedCodeBlocks(slice));
}

/**
 * Non-empty lines of a lean `## Slices` section outside fences (#6333 item 6),
 * or null when the heading is absent. The harvest identity hashes these lines.
 */
export function leanSlicesSectionLines(text: string): string[] | null {
  if (text.length === 0) {
    return null;
  }
  const heading = findLeanLevel2Heading(text, LEAN_SLICES_HEADING_RE);
  if (heading === null) {
    return null;
  }
  return stripFencedCodeBlocks(sliceLeanSection(text, heading))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export interface LeanSliceRef {
  /** `B` = Bound remedy list, `A` = Acceptance Criteria list. */
  readonly list: "B" | "A";
  /** 1-based position in that list. */
  readonly index: number;
}

export interface LeanSliceAssignment {
  readonly label: string;
  readonly refs: readonly LeanSliceRef[];
}

export type LeanSlices =
  | { readonly present: false }
  | {
      readonly present: true;
      readonly assignments: readonly LeanSliceAssignment[];
      readonly errors: readonly string[];
    };

const SLICE_LABEL_RE = /^[a-z0-9][a-z0-9-]*$/;
const SLICE_REF_RE = /^([BA])(\d+)$/;

/**
 * Parse a lean `## Slices` section (#6333 item 6). Closed grammar: one list
 * line per label, `- <label>: B1, B2, A3`, where `B<n>` is the n-th Bound
 * remedy item and `A<n>` the n-th Acceptance Criteria item. Prose lines are
 * ignored; a list line outside the grammar is an error.
 */
export function parseLeanSlices(text: string): LeanSlices {
  const lines = leanSlicesSectionLines(text);
  if (lines === null) {
    return { present: false };
  }
  const assignments: LeanSliceAssignment[] = [];
  const errors: string[] = [];
  const labels = new Set<string>();
  for (const line of lines) {
    const item = matchListItemLine(line);
    if (item === null) {
      continue;
    }
    const colon = item.indexOf(":");
    const label = colon < 0 ? "" : item.slice(0, colon).trim().replace(/^`|`$/g, "");
    if (!SLICE_LABEL_RE.test(label)) {
      errors.push(`slice line is not '- <label>: B<n>, A<n>': ${item}`);
      continue;
    }
    if (labels.has(label)) {
      errors.push(`slice label '${label}' is listed twice`);
      continue;
    }
    const refs: LeanSliceRef[] = [];
    let bad = false;
    for (const token of item
      .slice(colon + 1)
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)) {
      const ref = SLICE_REF_RE.exec(token);
      if (ref === null || Number(ref[2]) < 1) {
        errors.push(`slice '${label}' has a reference that is not B<n> or A<n>: ${token}`);
        bad = true;
        break;
      }
      refs.push({ list: ref[1] === "B" ? "B" : "A", index: Number(ref[2]) });
    }
    if (bad) {
      continue;
    }
    if (refs.length === 0) {
      errors.push(`slice '${label}' assigns no items`);
      continue;
    }
    labels.add(label);
    assignments.push({ label, refs });
  }
  if (assignments.length === 0 && errors.length === 0) {
    errors.push("Slices section assigns no items");
  }
  return { present: true, assignments, errors };
}

export type SliceLine =
  | { readonly kind: "none" }
  | { readonly kind: "slice"; readonly parent: number; readonly label: string }
  | { readonly kind: "malformed"; readonly detail: string };

const SLICE_LINE_START_RE = /^deft-slice:/i;
const SLICE_LINE_RE = /^deft-slice:[ \t]+#?(\d+)[ \t]+([a-z0-9][a-z0-9-]*)[ \t]*$/;

/**
 * Closed slice line on a slice issue body (#6333 item 6): one operative line
 * `deft-slice: <parent issue> <label>`, outside fences, quotes and code.
 */
export function parseSliceLine(body: string): SliceLine {
  let offset = 0;
  const found: { parent: number; label: string }[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (SLICE_LINE_START_RE.test(line) && classifyPosition(body, offset) === null) {
      const match = SLICE_LINE_RE.exec(line);
      if (match === null) {
        return {
          kind: "malformed",
          detail: `slice line must read 'deft-slice: <parent issue> <label>': ${line}`,
        };
      }
      found.push({ parent: Number(match[1]), label: match[2] ?? "" });
    }
    offset += raw.length + 1;
  }
  if (found.length === 0) {
    return { kind: "none" };
  }
  const first = found[0] as { parent: number; label: string };
  if (found.some((entry) => entry.parent !== first.parent || entry.label !== first.label)) {
    return { kind: "malformed", detail: "issue body names more than one slice" };
  }
  if (!Number.isSafeInteger(first.parent) || first.parent < 1) {
    return { kind: "malformed", detail: "slice line names no parent issue number" };
  }
  return { kind: "slice", parent: first.parent, label: first.label };
}

/**
 * True when a list item in `sectionText` wraps onto an indented continuation
 * line (outside fences). The line-based item reader would drop that text (#6333).
 */
export function hasWrappedListItem(sectionText: string): boolean {
  let inItem = false;
  for (const line of stripFencedCodeBlocks(sectionText).split("\n")) {
    if (line.trim().length === 0) {
      inItem = false;
      continue;
    }
    if (matchListItemLine(line) !== null) {
      inItem = true;
      continue;
    }
    if (inItem && /^[ \t]/.test(line)) {
      return true;
    }
    inItem = false;
  }
  return false;
}

/** Bound-remedy limb titles: list items of the slice outside fenced examples. */
export function boundRemedyLimbItems(sourceText: string): CheckboxItem[] {
  return parseListItems(stripFencedCodeBlocks(sourceText));
}

/**
 * List lines under a `Reject` / `Not proposed` heading or label in a lean (#6265).
 * The block ends at the next heading, trailer label or whole-line colon label.
 */
export function extractLeanConstraintLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines: string[] = [];
  const seen = new Set<string>();
  let inBlock = false;
  for (const line of stripFencedCodeBlocks(text).split("\n")) {
    if (isLeanTrailerLine(line)) {
      inBlock = LEAN_CONSTRAINT_LABEL_RE.test(stripBoldMarkers(atxHeadingText(line) ?? line));
      continue;
    }
    const listItem = matchListItemLine(line);
    if (listItem === null) {
      const label = atxHeadingText(line) ?? (isSameShapeColonLabelLine(line) ? line : null);
      if (label !== null) {
        inBlock = LEAN_CONSTRAINT_LABEL_RE.test(stripBoldMarkers(label));
      }
      continue;
    }
    if (!inBlock) {
      continue;
    }
    const title = listItem.trim();
    if (title.length === 0 || seen.has(title)) {
      continue;
    }
    seen.add(title);
    lines.push(title);
  }
  return lines;
}

/** Closed Spec-path harvest: Bound-remedy heading plus parseListItems on that slice only. */
export function extractBoundRemedyHarvest(text: string): {
  readonly items: CheckboxItem[];
  readonly sourceText: string;
  /** Reject / Not proposed list lines of the same lean (#6265). */
  readonly constraintLines: string[];
} {
  const sourceText = sliceBoundRemedySection(text);
  if (sourceText === null) {
    return { items: [], sourceText: "", constraintLines: [] };
  }
  return {
    items: boundRemedyLimbItems(sourceText),
    sourceText,
    constraintLines: extractLeanConstraintLines(text),
  };
}

/**
 * Whole-line `Requirements:` colon-label match (#4671).
 * Case-insensitive label; trailing colon required; no same-line body text.
 */
export interface ColonLabelMatch {
  readonly sectionStart: number;
}

/** Find a whole-line Requirements: colon-label (case-insensitive). */
export function findRequirementsColonLabel(text: string): ColonLabelMatch | null {
  let offset = 0;
  for (const line of text.split("\n")) {
    if (isRequirementsColonLabelLine(line)) {
      return { sectionStart: offset + line.length };
    }
    offset += line.length + 1;
  }
  return null;
}

function isRequirementsColonLabelLine(line: string): boolean {
  return /^requirements:\s*$/i.test(line.trim());
}

/** True for any ATX heading line (0–3 leading spaces, `#`…`######` + space or EOL). */
function isAtxHeadingLine(line: string): boolean {
  let i = 0;
  while (i < line.length && i < 3 && line[i] === " ") {
    i += 1;
  }
  if (i >= line.length || line[i] !== "#") {
    return false;
  }
  let hashes = 0;
  while (i + hashes < line.length && line[i + hashes] === "#") {
    hashes += 1;
  }
  if (hashes < 1 || hashes > 6) {
    return false;
  }
  const after = i + hashes;
  return after >= line.length || line[after] === " ";
}

/**
 * Same-shape colon-label terminator: whole-line `Label:` (letters/digits/_/-/space),
 * not a list item. Distinct from inline `Label: value` prose.
 */
function isSameShapeColonLabelLine(line: string): boolean {
  if (matchListItemLine(line) !== null) {
    return false;
  }
  return /^[A-Za-z][A-Za-z0-9 _/-]*:\s*$/.test(line.trim());
}

/**
 * Slice after a colon-label until EOF, next ATX heading, or next same-shape `Label:` (#4671).
 */
export function sliceColonLabelSection(text: string, match: ColonLabelMatch): string {
  const after = text.slice(match.sectionStart);
  let offset = 0;
  for (const line of after.split("\n")) {
    if (offset > 0 && (isAtxHeadingLine(line) || isSameShapeColonLabelLine(line))) {
      return after.slice(0, offset);
    }
    offset += line.length + 1;
  }
  return after;
}

/** Body-only Requirements: list harvest via closed colon-label delimiter (#4671). */
export function extractRequirementsSectionItems(text: string): CheckboxItem[] {
  if (text.length === 0) {
    return [];
  }
  // Single pass: prefer the first non-empty Requirements: section (no per-label rescan).
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (!isRequirementsColonLabelLine(lines[i] ?? "")) {
      i += 1;
      continue;
    }
    i += 1;
    const bodyLines: string[] = [];
    while (i < lines.length) {
      const line = lines[i] ?? "";
      if (isAtxHeadingLine(line) || isSameShapeColonLabelLine(line)) {
        break;
      }
      bodyLines.push(line);
      i += 1;
    }
    const items = parseListItems(bodyLines.join("\n"));
    if (items.length > 0) {
      return items;
    }
  }
  return [];
}

/** Slice text until the next heading at the same or higher level. */
export function sliceAcSection(text: string, heading: AcHeadingMatch): string {
  const after = text.slice(heading.sectionStart);
  let offset = 0;
  for (const line of after.split("\n")) {
    if (offset > 0 && isHeadingAtOrAbove(line, heading.level)) {
      return after.slice(0, offset);
    }
    offset += line.length + 1;
  }
  return after;
}

function isHeadingAtOrAbove(line: string, level: number): boolean {
  if (!line.startsWith("#")) {
    return false;
  }
  let hashes = 0;
  while (hashes < line.length && line[hashes] === "#") {
    hashes += 1;
  }
  if (hashes < 1 || hashes > level) {
    return false;
  }
  return hashes <= level && (hashes >= line.length || line[hashes] === " ");
}

/** Parse bullet/numbered list items within a section. */
export function parseListItems(sectionText: string): CheckboxItem[] {
  const items: CheckboxItem[] = [];
  const seen = new Set<string>();
  for (const line of sectionText.split("\n")) {
    const bullet = matchListItemLine(line);
    if (bullet === null) {
      continue;
    }
    let title = bullet.trim();
    let status: "proposed" | "completed" = "proposed";
    const cb = matchLeadingCheckbox(title);
    if (cb !== null) {
      title = cb.title.trim();
      if (cb.checked) {
        status = "completed";
      }
    }
    if (title.length === 0 || seen.has(title)) {
      continue;
    }
    seen.add(title);
    items.push({ title, status });
  }
  return items;
}

function matchListItemLine(line: string): string | null {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) {
    i += 1;
  }
  if (i >= line.length) {
    return null;
  }
  if ("-*+".includes(line[i] as string)) {
    i += 1;
    while (i < line.length && (line[i] === " " || line[i] === "\t")) {
      i += 1;
    }
    return line.slice(i).trimEnd();
  }
  const numMatch = /^\d+[.)]/.exec(line.slice(i));
  if (numMatch === null) {
    return null;
  }
  i += numMatch[0].length;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) {
    i += 1;
  }
  return line.slice(i).trimEnd();
}

function matchLeadingCheckbox(title: string): { checked: boolean; title: string } | null {
  if (!title.startsWith("[")) {
    return null;
  }
  const close = title.indexOf("]");
  if (close < 0) {
    return null;
  }
  const marker = title.slice(1, close);
  if (marker !== " " && marker !== "x" && marker !== "X") {
    return null;
  }
  let rest = title.slice(close + 1);
  if (rest.startsWith(" ")) {
    rest = rest.slice(1);
  }
  return { checked: marker.toLowerCase() === "x", title: rest };
}
