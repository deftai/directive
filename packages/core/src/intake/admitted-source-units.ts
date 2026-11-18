/**
 * Admitted-source unit selector for the body route (#6609).
 *
 * One function picks the admitted text of an issue body, after the quarantine
 * scan and after fenced code is removed:
 * - list route: the body has an Acceptance Criteria heading with a list under
 *   it, so the units are those list items (wrapped lines joined);
 * - sentence route: otherwise the units are the statement sentences, without
 *   headings, reference lines, the generated footer and quoted lines.
 *
 * The legacy extractor (`extractAdmittedSourceSentencesFromText`) is not
 * changed. A pin stamped with `admitted_source_extractor: 2` is read with this
 * selector; a pin with no version keeps the legacy extractor.
 */
import { scan } from "../cache/scanner.js";
import { hasOperativeTargetDigestLine } from "../design-critique/completed-arc-record.js";
import { hasOperativeNotWarrantedSkip } from "../design-critique/ingest-posture.js";
import type { ForgeApprovalReader } from "../scope-provenance/forge-approval.js";
import { hasWritePermission } from "../scope-provenance/forge-approval.js";
import { extractStatementSentences } from "../verify-ac/clauses.js";
import { findAcHeading, sliceAcSection, stripFencedCodeBlocks } from "./markdown-scanners.js";

export type AdmittedSourceRoute = "list" | "sentence";

export interface AdmittedSourceUnitSelection {
  readonly route: AdmittedSourceRoute;
  readonly units: readonly string[];
  /** Checkbox state of each list unit (all `proposed` on the sentence route). */
  readonly statuses: readonly ("proposed" | "completed")[];
}

const LIST_ITEM_RE = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+(\S.*)$/;
const CHECKBOX_RE = /^\[([ xX])\](?:[ \t]+|$)/;
const HEADING_RE = /^[ \t]{0,3}#{1,6}(?:[ \t]|$)/;
const REF_LINE_RE = /^[ \t]*(?:Refs|Tracking|Closes|Fixes|Part of)[ \t]+(?:[\w.-]+\/[\w.-]+)?#\d+/i;
const FOOTER_LINE_RE = /^[ \t]*(?:\u{1F916}[ \t]*)?Generated with\b/iu;
const QUOTE_LINE_RE = /^[ \t]{0,3}>/;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function indentOf(whitespace: string): number {
  let width = 0;
  for (const ch of whitespace) {
    width += ch === "\t" ? 4 : 1;
  }
  return width;
}

/**
 * List items of a section as units: the item line without its bullet and
 * checkbox marker, plus each following line indented under it that is not
 * itself a list item, heading or blank line, joined with single spaces.
 * Repeated units are kept once.
 */
function listUnits(sectionText: string): {
  units: string[];
  statuses: ("proposed" | "completed")[];
} {
  const units: string[] = [];
  const statuses: ("proposed" | "completed")[] = [];
  const seen = new Set<string>();
  const lines = sectionText.split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const item = LIST_ITEM_RE.exec(line);
    index += 1;
    if (item === null) {
      continue;
    }
    const baseIndent = indentOf(item[1] ?? "");
    let first = (item[2] ?? "").trim();
    let status: "proposed" | "completed" = "proposed";
    const checkbox = CHECKBOX_RE.exec(first);
    if (checkbox !== null) {
      status = checkbox[1] === " " ? "proposed" : "completed";
      first = first.slice(checkbox[0].length).trim();
    }
    const parts: string[] = [first];
    while (index < lines.length) {
      const next = lines[index] ?? "";
      if (next.trim().length === 0 || LIST_ITEM_RE.test(next) || HEADING_RE.test(next)) {
        break;
      }
      const lead = /^[ \t]*/.exec(next)?.[0] ?? "";
      if (indentOf(lead) <= baseIndent) {
        break;
      }
      parts.push(next.trim());
      index += 1;
    }
    const unit = collapse(parts.join(" "));
    if (unit.length === 0 || seen.has(unit)) {
      continue;
    }
    seen.add(unit);
    units.push(unit);
    statuses.push(status);
  }
  return { units, statuses };
}

function stripCheckboxMarker(line: string): string {
  const item = LIST_ITEM_RE.exec(line);
  if (item === null) {
    return line;
  }
  const rest = item[2] ?? "";
  const checkbox = CHECKBOX_RE.exec(rest);
  if (checkbox === null) {
    return line;
  }
  const marker = line.slice(0, line.length - rest.length);
  return `${marker}${rest.slice(checkbox[0].length)}`;
}

/**
 * Sentences of fence-free text, as `extractStatementSentences` finds them,
 * except that a heading, a reference line, the generated footer and a quoted
 * line each end the running span and are never part of a sentence.
 */
function sentenceUnits(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let block: string[] = [];
  const flush = (): void => {
    if (block.length === 0) {
      return;
    }
    const sentences = extractStatementSentences(block.join("\n"));
    block = [];
    for (const sentence of sentences) {
      const key = sentence.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(sentence);
      }
    }
  };
  for (const line of text.split(/\r?\n/)) {
    if (
      HEADING_RE.test(line) ||
      REF_LINE_RE.test(line) ||
      FOOTER_LINE_RE.test(line) ||
      QUOTE_LINE_RE.test(line)
    ) {
      flush();
      continue;
    }
    block.push(stripCheckboxMarker(line));
  }
  flush();
  return out;
}

/** Route and units of a body (#6609). Quarantine scan, then fence removal, first. */
export function selectAdmittedSourceUnits(body: string): AdmittedSourceUnitSelection {
  const scanned = scan(body).transformed_content;
  const text = stripFencedCodeBlocks(scanned);
  const heading = findAcHeading(text);
  if (heading !== null) {
    const list = listUnits(sliceAcSection(text, heading));
    if (list.units.length > 0) {
      return { route: "list", units: list.units, statuses: list.statuses };
    }
  }
  const units = sentenceUnits(text.trim());
  return { route: "sentence", units, statuses: units.map(() => "proposed") };
}

/** Admitted-source units of a body (version 2 of the admitted-source extractor). */
export function admittedSourceUnitsFromBody(text: string): string[] {
  return [...selectAdmittedSourceUnits(text).units];
}

/**
 * Items of the `## Acceptance Criteria` list of a comment (fence-free, wrapped
 * lines joined). Empty when the comment has no such list.
 */
export function criteriaListUnits(commentBody: string): string[] {
  const text = stripFencedCodeBlocks(commentBody);
  const heading = findAcHeading(text);
  if (heading === null) {
    return [];
  }
  return listUnits(sliceAcSection(text, heading)).units;
}

/** Comment shape of a criteria-only record: not-warranted line, Target-digest, criteria list. */
export function hasCriteriaOnlyRecordShape(commentBody: string): boolean {
  return (
    hasOperativeNotWarrantedSkip(null, [{ id: 0, body: commentBody }]) &&
    hasOperativeTargetDigestLine(commentBody) &&
    criteriaListUnits(commentBody).length > 0
  );
}

export interface CriteriaOnlyCandidate {
  readonly id: number;
  readonly body: string;
  /** Comment author login, or null when the row has none. */
  readonly login: string | null;
}

export type CriteriaOnlySelection =
  | { readonly status: "none" }
  | {
      readonly status: "found";
      readonly commentId: number;
      readonly body: string;
      readonly items: readonly string[];
    };

/**
 * Is the commenter the issue's author, or an account with write access read
 * through the existing collaborator-permission lookup? A failed read is no.
 */
export function mayWriteCriteriaOnlyRecord(input: {
  readonly login: string | null;
  readonly issueAuthor: string | null;
  readonly repo: string;
  readonly reader: Pick<ForgeApprovalReader, "getJson">;
}): boolean {
  const { login, issueAuthor } = input;
  if (login === null || login.length === 0) {
    return false;
  }
  if (issueAuthor !== null && issueAuthor.toLowerCase() === login.toLowerCase()) {
    return true;
  }
  const perm = hasWritePermission(input.reader, input.repo, login);
  return perm.ok && perm.value;
}

/**
 * The latest criteria-only record comment on a thread (#6609 item 6): a
 * qualifying shape written by the issue's author or an account with write access.
 */
export function selectCriteriaOnlyRecord(input: {
  readonly comments: readonly CriteriaOnlyCandidate[];
  readonly issueAuthor: string | null;
  readonly repo: string;
  readonly reader: Pick<ForgeApprovalReader, "getJson">;
}): CriteriaOnlySelection {
  const candidates = input.comments
    .filter((comment) => hasCriteriaOnlyRecordShape(comment.body))
    .sort((a, b) => b.id - a.id);
  for (const comment of candidates) {
    if (
      mayWriteCriteriaOnlyRecord({
        login: comment.login,
        issueAuthor: input.issueAuthor,
        repo: input.repo,
        reader: input.reader,
      })
    ) {
      return {
        status: "found",
        commentId: comment.id,
        body: comment.body,
        items: criteriaListUnits(comment.body),
      };
    }
  }
  return { status: "none" };
}
