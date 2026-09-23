/**
 * Rung-2 derived AC: decompose the task statement into testable clauses
 * at intake; walk every clause against the shipped artifact at done (#3323).
 */

import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import {
  findAcHeading,
  parseListItems,
  sliceAcSection,
  stripFencedCodeBlocks,
} from "../intake/markdown-scanners.js";
import { hasGlobMagic, matchAny } from "../orchestration/pathspec.js";

export type ClauseOutcome = "verified" | "unverifiable" | "failed";

export interface AcceptanceClauseReading {
  readonly text: string;
  readonly artifact_path: string | null;
}

export interface AcceptanceClause {
  readonly id: number;
  readonly text: string;
  readonly artifact_path: string | null;
  readonly ambiguous: boolean;
  readonly readings?: readonly AcceptanceClauseReading[];
  readonly chosen_reading?: number;
}

export interface ClauseWalkResult {
  readonly id: number;
  readonly text: string;
  readonly artifact_path: string | null;
  readonly outcome: ClauseOutcome;
  readonly detail: string;
  /**
   * True when the walk had an oracle for this clause — a declared path plus
   * extractable tokens or an existence claim. An unbound, undeclared, or
   * bound-behavioral clause can only ever come back `unverifiable`, so it
   * carries no weight either way (#3835 / #4240).
   */
  readonly adjudicable: boolean;
}

/** Read-scope for the walk. Empty means nothing is read (#3835). */
export interface ClauseWalkOptions {
  /**
   * The brief's declared artifact surface: `plan.metadata.swarm.file_scope`,
   * which carries the #3145 approved-scope digest and `humanApproval` gate.
   *
   * Required rather than optional, and fail-closed when empty: the walk reads
   * files, and a caller that forgets to pass a scope must read nothing rather
   * than fall back to whatever path a clause happens to carry.
   */
  readonly declaredScope: readonly string[];
}

export interface ClauseWalkReport {
  readonly clauses: readonly ClauseWalkResult[];
  readonly failed: readonly ClauseWalkResult[];
  readonly unverifiable: readonly ClauseWalkResult[];
  readonly verified: readonly ClauseWalkResult[];
  readonly ok: boolean;
  readonly message: string;
}

const SECTION_HEADING = /^(#{1,6})\s+(acceptance(?:\s+criteria|\s+sketch)?|fix)\s*$/i;
const LABELED_AC_PREFIXES = ["test:", "acceptance:", "acceptancecriteria:"] as const;
const META_CLAUSE = /^(relates?\s+#|refs?\s+#)/i;
const FILE_EXT = /\.(?:ts|tsx|js|mjs|cjs|json|md|go|py|yml|yaml|txt)$/i;
const SCRATCH_SEGMENTS = new Set([
  "tmp",
  "temp",
  ".deft-scratch",
  "node_modules",
  "scratch",
  "buffer",
]);
const EXISTENCE_CLAIM =
  /\b(?:exists?|stored on|written to|emitted? (?:at|to)|at its stated path|artifact path)\b/i;
const ABSENCE_ALTERNATION =
  "does not exist|doesn't exist|must not exist|never exists?|not exist|must be absent|must remain absent|must stay absent|should be absent|must not be present|should not exist|must not be shipped";
const NEGATED_EXISTENCE = new RegExp(`\\b(?:${ABSENCE_ALTERNATION})\\b`, "i");

function stripLeadingDotSlash(path: string): string {
  let unified = path.replace(/\\/g, "/");
  while (unified.startsWith("./")) {
    unified = unified.slice(2);
  }
  return unified;
}

function hasPathToken(text: string, token: string): boolean {
  if (token.length === 0) {
    return false;
  }
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const isShortBare = token.length < 3 && !token.includes(".") && !token.includes("/");
  if (isShortBare) {
    // 2-char names (`ab`, `go`) are also English words. Only treat them as the
    // bound artifact when they are the subject of the absence phrase, or `./go`.
    if (token.length < 2) {
      return false;
    }
    const asSubject = new RegExp(
      `(?:^|[\\s'"\`./])${escaped}(?:\\s+\\w+){0,1}\\s+(?:${ABSENCE_ALTERNATION})\\b`,
      "i",
    );
    const asPrefixed = new RegExp(`(?:^|[\\s])\\./${escaped}(?![A-Za-z0-9._-])`);
    return asSubject.test(text) || asPrefixed.test(text);
  }
  // `./src/result.ts` must still name bound `src/result.ts`: allow a `./` prefix
  // as a boundary, not only start-of-string or a non-path character.
  return new RegExp(`(?:^|[^A-Za-z0-9_./\\\\-]|\\./)${escaped}(?![A-Za-z0-9._-])`).test(text);
}

/** True when the clause names the bound path, not some other runtime subject. */
function clauseNamesBoundArtifact(text: string, artifactPath: string): boolean {
  const unified = stripLeadingDotSlash(artifactPath);
  const candidates = [artifactPath, unified, `./${unified}`];
  const base = basename(unified);
  if (base.length > 0) {
    candidates.push(base, `./${base}`);
  }
  return candidates.some((candidate) => hasPathToken(text, candidate));
}

function isBoundArtifactAbsenceClaim(text: string, artifactPath: string): boolean {
  return NEGATED_EXISTENCE.test(text) && clauseNamesBoundArtifact(text, artifactPath);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeClauseText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function looksLikeFilePath(token: string): boolean {
  const t = token.trim().replace(/^['"`]|['"`]$/g, "");
  if (t.length < 3 || t.includes("://") || t.includes(" ")) {
    return false;
  }
  if (t.startsWith("plan.") || (t.includes(":") && !t.includes("/") && !t.includes("\\"))) {
    return false;
  }
  const unified = t.replace(/\\/g, "/");
  if (FILE_EXT.test(unified)) {
    return true;
  }
  return unified.includes("/") && !unified.startsWith("#");
}

function extractPathTokens(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const token = raw.trim().replace(/^['"`]|['"`]$/g, "");
    if (!looksLikeFilePath(token) || seen.has(token)) {
      return;
    }
    seen.add(token);
    found.push(token);
  };
  const backtick = /`([^`\n]{2,200})`/g;
  let match = backtick.exec(text);
  while (match !== null) {
    push(match[1] ?? "");
    match = backtick.exec(text);
  }
  const bare =
    /(?<![A-Za-z0-9_])((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z][A-Za-z0-9]+)(?![A-Za-z0-9_])/g;
  match = bare.exec(text);
  while (match !== null) {
    push(match[1] ?? "");
    match = bare.exec(text);
  }
  return found;
}

function isMetaClause(text: string): boolean {
  return META_CLAUSE.test(text.trim());
}

function collectSectionItems(text: string, headingRe: RegExp): string[] {
  const items: string[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const match = headingRe.exec(line.trim());
    if (match !== null) {
      const hashes = (match[1] ?? "#").length;
      const section = sliceAcSection(text, {
        level: hashes,
        sectionStart: offset + line.length + 1,
      });
      for (const item of parseListItems(section)) {
        const title = normalizeClauseText(stripInlineMarkdownBold(item.title));
        if (title.length > 0 && !isMetaClause(title)) {
          items.push(title);
        }
      }
    }
    offset += line.length + 1;
  }
  return items;
}

function matchLabeledAcLine(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const lower = trimmed.toLowerCase();
  for (const prefix of LABELED_AC_PREFIXES) {
    if (!lower.startsWith(prefix)) {
      continue;
    }
    const body = trimmed.slice(prefix.length).trim();
    return body.length > 0 ? body : null;
  }
  return null;
}

function collectLabeledLines(text: string): string[] {
  const items: string[] = [];
  for (const line of text.split("\n")) {
    const body = matchLabeledAcLine(line);
    if (body !== null && !isMetaClause(body)) {
      items.push(normalizeClauseText(body));
    }
  }
  return items;
}

function collectPathBearingLines(text: string): string[] {
  const items: string[] = [];
  for (const item of parseListItems(text)) {
    const title = normalizeClauseText(stripInlineMarkdownBold(item.title));
    if (title.length === 0 || isMetaClause(title)) {
      continue;
    }
    if (extractPathTokens(title).length > 0) {
      items.push(title);
    }
  }
  return items;
}

/**
 * Acceptance lines declared on `plan.items` (#3826).
 *
 * Prefers `item.narrative.Acceptance`, then `item.title` — criteria routinely live
 * in the title with an empty `narrative`, which is how a declared acceptance
 * surface stayed invisible to derivation on #3794 and #3819.
 */
export function collectPlanItemAcceptanceSurface(plan: Record<string, unknown>): string[] {
  if (!Array.isArray(plan.items)) {
    return [];
  }
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const entry of plan.items) {
    const item = asRecord(entry);
    if (item === null) {
      continue;
    }
    const narrative = asRecord(item.narrative);
    const declared = narrative === null ? undefined : narrative.Acceptance;
    const source = isNonEmptyString(declared) ? declared : item.title;
    if (!isNonEmptyString(source)) {
      continue;
    }
    const line = normalizeClauseText(stripInlineMarkdownBold(source));
    const key = line.toLowerCase();
    if (line.length === 0 || isMetaClause(line) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    lines.push(line);
  }
  return lines;
}

/**
 * Strip `**` bold markers so clause text can match the authored field.
 * Do not strip `__` — dunder tokens such as `__init__` are identifiers (#4374).
 */
export function stripInlineMarkdownBold(text: string): string {
  return text.replace(/\*\*/g, "");
}

/** Narrative keys the activate gate and declared-key parse share (#3334 / #4374). */
export const DECLARED_ACCEPTANCE_NARRATIVE_KEYS = new Set([
  "test",
  "acceptancecriteria",
  "verification",
]);

export function normalizeAcceptanceNarrativeKey(key: string): string {
  return key.replace(/[\s_-]+/g, "").toLowerCase();
}

export interface DeclaredAcceptanceNarrativeSurface {
  /** True when at least one acceptance-shaped narrative key has a non-empty string. */
  readonly present: boolean;
  /** List items, else labeled lines, from those keys. Empty when the field is bare prose. */
  readonly lines: readonly string[];
  /** Original narrative keys that were non-empty (for named 0-clause notices). */
  readonly keys: readonly string[];
  /**
   * Parseable lines from AcceptanceCriteria only (#4867).
   * Empty when that key is absent or bare prose. Not a subset of `lines`
   * after cross-key dedupe: a line that also appears on Test still counts.
   */
  readonly acceptanceCriteriaLines: readonly string[];
}

/**
 * Parse AcceptanceCriteria / Test / Verification as a declared surface (#4374).
 *
 * List items first, else `test:` / `acceptance:` labeled lines. Bare prose in
 * the field is not a clause. The JSON key is the section delimiter — do not
 * scrape Overview or the concatenated statement blob.
 */
export function collectDeclaredAcceptanceNarrativeSurface(
  plan: Record<string, unknown>,
): DeclaredAcceptanceNarrativeSurface {
  const narratives = asRecord(plan.narratives);
  if (narratives === null) {
    return { present: false, lines: [], keys: [], acceptanceCriteriaLines: [] };
  }
  const keys: string[] = [];
  const lines: string[] = [];
  const acceptanceCriteriaLines: string[] = [];
  const seen = new Set<string>();
  const acceptanceCriteriaSeen = new Set<string>();
  for (const key of Object.keys(narratives)) {
    if (!DECLARED_ACCEPTANCE_NARRATIVE_KEYS.has(normalizeAcceptanceNarrativeKey(key))) {
      continue;
    }
    const value = narratives[key];
    if (!isNonEmptyString(value)) {
      continue;
    }
    keys.push(key);
    const fromList = parseListItems(value)
      .map((item) => normalizeClauseText(stripInlineMarkdownBold(item.title)))
      .filter((title) => title.length > 0 && !isMetaClause(title));
    const parsed = fromList.length > 0 ? fromList : collectLabeledLines(value);
    const isAcceptanceCriteria = normalizeAcceptanceNarrativeKey(key) === "acceptancecriteria";
    for (const line of parsed) {
      const dedupe = line.toLowerCase();
      if (isAcceptanceCriteria && !acceptanceCriteriaSeen.has(dedupe)) {
        acceptanceCriteriaSeen.add(dedupe);
        acceptanceCriteriaLines.push(line);
      }
      if (seen.has(dedupe)) {
        continue;
      }
      seen.add(dedupe);
      lines.push(line);
    }
  }
  return { present: keys.length > 0, lines, keys, acceptanceCriteriaLines };
}

export function formatZeroClauseAcceptanceShapedNotice(keys: readonly string[]): string {
  const listed = keys.length > 0 ? keys.join(", ") : "AcceptanceCriteria, Test, Verification";
  return (
    `0 clauses derived from acceptance-shaped narrative keys (${listed}). ` +
    "Accepted shapes: list items (`- ` / `1.`) in the declared key, or `test:` / `acceptance:` labeled lines. " +
    "Bare prose is not derivable (#4374). Do not stamp write-time plan.acceptance { none_stated: true }."
  );
}

export interface ClauseDerivationSources {
  /**
   * Declared acceptance lines from `plan.items` (#3826). When non-empty, and
   * AcceptanceCriteria has no parseable lines, this is the clause set. Item
   * titles in this list are not the clause set when AcceptanceCriteria lines
   * parse (#4867).
   */
  readonly itemSurface?: readonly string[];
  /**
   * Declared AcceptanceCriteria / Test / Verification parse (#4374). When
   * `present` is true and the item surface is empty, this is the clause set
   * even if `lines` is empty — do not fall through to statement scrape.
   * Parseable `acceptanceCriteriaLines` replace a non-empty item surface (#4867).
   */
  readonly declaredNarrative?: DeclaredAcceptanceNarrativeSurface;
}

/** Acceptance lines the statement itself declares, in extractor precedence order. */
function collectStatementSurface(text: string): string[] {
  const raw: string[] = [];
  const acHeading = findAcHeading(text);
  if (acHeading !== null) {
    raw.push(
      ...parseListItems(sliceAcSection(text, acHeading))
        .map((item) => normalizeClauseText(stripInlineMarkdownBold(item.title)))
        .filter((title) => title.length > 0 && !isMetaClause(title)),
    );
  }
  raw.push(...collectSectionItems(text, SECTION_HEADING));
  raw.push(...collectLabeledLines(text));
  if (raw.length === 0) {
    raw.push(...collectPathBearingLines(text));
  }
  return raw;
}

/** Numbered independently testable clauses from the task statement (#3323). */
export function deriveAcceptanceClauses(
  taskStatement: string,
  sources: ClauseDerivationSources = {},
): AcceptanceClause[] {
  const text = taskStatement.trim();
  const itemSurface = (sources.itemSurface ?? [])
    .map((line) => normalizeClauseText(line))
    .filter((line) => line.length > 0 && !isMetaClause(line));
  const declared = sources.declaredNarrative;
  const acceptanceCriteriaLines = (declared?.acceptanceCriteriaLines ?? [])
    .map((line) => normalizeClauseText(line))
    .filter((line) => line.length > 0 && !isMetaClause(line));
  // #3826: `plan.items` stays ahead of statement scrape and of Test / Verification,
  // so a thread heading cannot become the gate. #4867: parseable
  // AcceptanceCriteria lines are the clause texts even when that item surface
  // is non-empty. Item titles are not that set. Bare prose stays off this path.
  let raw: readonly string[];
  if (itemSurface.length > 0 && acceptanceCriteriaLines.length > 0) {
    raw = acceptanceCriteriaLines;
  } else if (itemSurface.length > 0) {
    raw = itemSurface;
  } else if (declared?.present === true) {
    raw = declared.lines
      .map((line) => normalizeClauseText(line))
      .filter((line) => line.length > 0 && !isMetaClause(line));
  } else {
    raw = text.length > 0 ? collectStatementSurface(text) : [];
  }
  const seen = new Set<string>();
  const clauses: AcceptanceClause[] = [];
  for (const line of raw) {
    const key = line.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    clauses.push(buildClause(clauses.length + 1, line));
  }
  return clauses;
}

/**
 * Clause text is untrusted: the statement is the issue body plus its whole
 * comment thread, and anyone can comment on a public issue. Lifting a path out
 * of it chose both the file `walkOne` read and the needle it matched, so a
 * third-party comment could ask the gate a question about any in-root file and
 * read the answer off the report (#3835).
 *
 * Derivation therefore binds no path at all. `walkOne` binds only what the brief
 * declares on `plan.metadata.swarm.file_scope`. Measured across the six live
 * briefs at filing, prose extraction bound two paths and verified zero clauses,
 * so this costs no verification capability.
 */
function buildClause(id: number, text: string): AcceptanceClause {
  return { id, text, artifact_path: null, ambiguous: false };
}

export function readAcceptanceClauses(acceptance: unknown): AcceptanceClause[] {
  const rec = asRecord(acceptance);
  if (rec === null || !Array.isArray(rec.clauses)) {
    return [];
  }
  const out: AcceptanceClause[] = [];
  for (const [index, entry] of rec.clauses.entries()) {
    const row = asRecord(entry);
    if (row === null) {
      continue;
    }
    const text = isNonEmptyString(row.text) ? normalizeClauseText(row.text) : "";
    if (text.length === 0) {
      continue;
    }
    const artifact = isNonEmptyString(row.artifact_path)
      ? row.artifact_path.trim()
      : isNonEmptyString(row.artifactPath)
        ? row.artifactPath.trim()
        : null;
    const readings = Array.isArray(row.readings)
      ? row.readings
          .map((reading) => {
            const rr = asRecord(reading);
            if (rr === null || !isNonEmptyString(rr.text)) {
              return null;
            }
            const path = isNonEmptyString(rr.artifact_path)
              ? rr.artifact_path.trim()
              : isNonEmptyString(rr.artifactPath)
                ? rr.artifactPath.trim()
                : null;
            return { text: rr.text.trim(), artifact_path: path };
          })
          .filter((r): r is AcceptanceClauseReading => r !== null)
      : [];
    const ambiguous = row.ambiguous === true || readings.length > 1;
    const chosen =
      typeof row.chosen_reading === "number"
        ? row.chosen_reading
        : typeof row.chosenReading === "number"
          ? row.chosenReading
          : 0;
    const chosenPath =
      ambiguous && readings[chosen] !== undefined ? readings[chosen].artifact_path : artifact;
    out.push({
      id: typeof row.id === "number" && row.id > 0 ? row.id : index + 1,
      text,
      artifact_path: chosenPath,
      ambiguous,
      ...(readings.length > 0 ? { readings, chosen_reading: chosen } : {}),
    });
  }
  return out;
}

export function serializeAcceptanceClauses(
  clauses: readonly AcceptanceClause[],
): Record<string, unknown>[] {
  return clauses.map((clause) => {
    const row: Record<string, unknown> = {
      id: clause.id,
      text: clause.text,
      artifact_path: clause.artifact_path,
      ambiguous: clause.ambiguous,
    };
    if (clause.ambiguous && clause.readings !== undefined) {
      row.readings = clause.readings.map((reading) => ({
        text: reading.text,
        artifact_path: reading.artifact_path,
      }));
      row.chosen_reading = clause.chosen_reading ?? 0;
    }
    return row;
  });
}

/**
 * When no commands are stated, stamp derived clauses onto plan.acceptance
 * and promote source_rung to derived. Leaves stated-command acceptance alone.
 */
export function stampDerivedClausesOnAcceptance(
  plan: Record<string, unknown>,
  taskStatement: string,
): { readonly plan: Record<string, unknown>; readonly clauses: readonly AcceptanceClause[] } {
  const rec = asRecord(plan.acceptance);
  if (rec === null) {
    return { plan, clauses: [] };
  }
  if (rec.none_stated !== true) {
    return { plan, clauses: [] };
  }
  const commands = rec.commands;
  if (Array.isArray(commands) && commands.length > 0) {
    return { plan, clauses: [] };
  }
  const clauses = deriveAcceptanceClauses(taskStatement, {
    itemSurface: collectPlanItemAcceptanceSurface(plan),
    declaredNarrative: collectDeclaredAcceptanceNarrativeSurface(plan),
  });
  if (clauses.length === 0) {
    return { plan, clauses: [] };
  }
  return {
    plan: {
      ...plan,
      acceptance: {
        ...rec,
        none_stated: true,
        source_rung: "derived",
        derived_reason: `derived ${clauses.length} independently testable clauses from the task statement before product edit (#3323)`,
        clauses: serializeAcceptanceClauses(clauses),
      },
    },
    clauses,
  };
}

export function isScratchArtifactPath(artifactPath: string): boolean {
  const unified = artifactPath.replace(/\\/g, "/").toLowerCase();
  return unified.split("/").some((seg) => SCRATCH_SEGMENTS.has(seg));
}

/**
 * Repo-relative comparison form: forward slashes, no `./` prefix, no trailing slash.
 *
 * Segment-split rather than regex-replaced: the inputs include clause text a
 * commenter wrote, and the anchored slash-run patterns this replaced backtrack
 * quadratically on a long run of separators (`js/polynomial-redos`).
 */
function normalizeScopePath(value: string): string {
  const unified = value.trim().split("\\").join("/");
  const rooted = unified.startsWith("/") ? "/" : "";
  const segments = unified.split("/").filter((segment) => segment.length > 0);
  if (rooted.length === 0 && segments[0] === ".") {
    segments.shift();
  }
  return rooted + segments.join("/");
}

/**
 * The declared artifact surface for a brief: `plan.metadata.swarm.file_scope`.
 *
 * This is the only surface the walk reads from (#3835). It sits inside the
 * xBRIEF, so a GitHub commenter cannot write it, and it is already gated by the
 * #3145 approved-scope digest and `humanApproval` stamp.
 */
export function readDeclaredArtifactScope(plan: unknown): string[] {
  const swarm = asRecord(asRecord(asRecord(plan)?.metadata)?.swarm);
  if (swarm === null || !Array.isArray(swarm.file_scope)) {
    return [];
  }
  const declared = new Set<string>();
  for (const entry of swarm.file_scope) {
    if (!isNonEmptyString(entry)) {
      continue;
    }
    const normalized = normalizeScopePath(entry);
    if (normalized.length > 0) {
      declared.add(normalized);
    }
  }
  return [...declared];
}

/**
 * True when a non-glob path is in declared file_scope (#4840 / #3835).
 * Glob entries match via `matchAny`. Unstarred entries stay directory prefixes
 * (`classifyGlob` prefix/depth). Glob-shaped pointers are refused here; walk's
 * `statSync.isFile` then fails directories.
 */
export function isDeclaredArtifactPath(
  artifactPath: string,
  declaredScope: readonly string[],
): boolean {
  const candidate = normalizeScopePath(artifactPath);
  if (candidate.length === 0 || candidate === ".." || candidate.startsWith("../")) {
    return false;
  }
  if (hasGlobMagic(candidate)) {
    return false;
  }
  if (matchAny(declaredScope, candidate)) {
    return true;
  }
  return declaredScope.some((raw) => {
    if (hasGlobMagic(raw)) {
      return false;
    }
    const entry = normalizeScopePath(raw);
    return entry.length > 0 && (candidate === entry || candidate.startsWith(`${entry}/`));
  });
}

function isContained(root: string, child: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** File-token shape: non-glob path. Bind still refuses glob-shaped pointers. */
export function isFileShapedPointer(path: string): boolean {
  const candidate = normalizeScopePath(path);
  return candidate.length > 0 && !hasGlobMagic(candidate);
}

/** Stamp's isFile check: refuse directories, missing paths, and symlink escape. */
function isShippedFilePointer(projectRoot: string, pointer: string): boolean {
  const abs = resolve(projectRoot, pointer);
  if (!isContained(projectRoot, abs)) {
    return false;
  }
  try {
    const info = lstatSync(abs);
    if (!info.isFile() && !info.isSymbolicLink()) {
      return false;
    }
    const projectReal = realpathSync(projectRoot);
    const pointerReal = realpathSync(abs);
    const rel = relative(projectReal, pointerReal);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      return false;
    }
    return statSync(pointerReal).isFile();
  } catch {
    return false;
  }
}

/**
 * Promotion bind matcher (#4840 / #4008).
 * Glob-shaped pointers are refused. An existing directory is refused.
 * A missing matchAny path may bind so promotion can name a future in-scope
 * file. Existing targets reuse stamp realpath containment so an in-repo
 * symlink that escapes the project cannot bind. Stamp and walk still
 * require a contained regular file.
 */
export function isBindableMatchAnyFilePointer(
  path: string,
  declaredScope: readonly string[],
  projectRoot: string,
): boolean {
  const candidate = normalizeScopePath(path);
  if (!isFileShapedPointer(candidate) || !matchAny(declaredScope, candidate)) {
    return false;
  }
  const abs = resolve(projectRoot, candidate);
  if (!isContained(projectRoot, abs)) {
    return false;
  }
  try {
    if (!existsSync(abs)) {
      return true;
    }
    return isShippedFilePointer(projectRoot, candidate);
  } catch {
    return false;
  }
}

/** Stamp matcher: bindable shape plus a contained regular file (#4840). */
export function isMatchAnyFilePointer(
  path: string,
  declaredScope: readonly string[],
  projectRoot: string,
): boolean {
  const candidate = normalizeScopePath(path);
  return (
    isFileShapedPointer(candidate) &&
    matchAny(declaredScope, candidate) &&
    isShippedFilePointer(projectRoot, candidate)
  );
}

export type ClauseBindFailureKind = "unbound-path" | "ambiguous-scope" | "undeclared-binding";

export interface ClauseBindFailure {
  readonly id: number;
  readonly text: string;
  readonly kind: ClauseBindFailureKind;
  readonly detail: string;
}

export interface ClauseFileScopeBindResult {
  readonly ok: boolean;
  readonly changed: boolean;
  readonly clauses: readonly AcceptanceClause[];
  readonly failures: readonly ClauseBindFailure[];
  readonly message: string;
}

type BoundPathResult =
  | { readonly ok: true; readonly path: string | null }
  | { readonly ok: false; readonly kind: ClauseBindFailureKind; readonly detail: string };

function isPathContinueChar(ch: string): boolean {
  return ch.length === 1 && /[A-Za-z0-9_./\\-]/.test(ch);
}

function memberNeedles(member: string): string[] {
  const unix = member.split("\\").join("/");
  const win = unix.split("/").join("\\");
  const out = new Set<string>();
  for (const base of [unix, win]) {
    out.add(base);
    out.add(`./${base}`);
    out.add(`.\\${base}`);
    out.add(`${base}/`);
    out.add(`${base}\\`);
    out.add(`./${base}/`);
    out.add(`.\\${base}\\`);
  }
  return [...out];
}

/** Exact declared member in clause text, including extensionless directory paths. */
function memberAppearsInText(text: string, member: string): boolean {
  if (member.length < 2) {
    return false;
  }
  const needles = memberNeedles(member);
  for (const needle of needles) {
    let from = 0;
    while (from < text.length) {
      const idx = text.indexOf(needle, from);
      if (idx < 0) {
        break;
      }
      const before = idx === 0 ? "" : (text[idx - 1] ?? "");
      const after = text[idx + needle.length] ?? "";
      if (!isPathContinueChar(before) && !isPathContinueChar(after)) {
        return true;
      }
      from = idx + 1;
    }
  }
  return false;
}

function uniqueMatchAnyFileHits(
  tokens: readonly string[],
  declared: readonly string[],
  text: string,
  projectRoot: string,
): string[] {
  const hits = new Set<string>();
  for (const token of tokens) {
    const normalized = normalizeScopePath(token);
    if (isBindableMatchAnyFilePointer(normalized, declared, projectRoot)) {
      hits.add(normalized);
    }
  }
  for (const member of declared) {
    const normalized = normalizeScopePath(member);
    if (!isBindableMatchAnyFilePointer(normalized, declared, projectRoot)) {
      continue;
    }
    if (memberAppearsInText(text, member) || memberAppearsInText(text, normalized)) {
      hits.add(normalized);
    }
  }
  return [...hits];
}

function bindStoredOrTokens(
  storedPath: string | null,
  text: string,
  declared: readonly string[],
  projectRoot: string,
): BoundPathResult {
  if (storedPath !== null && storedPath.trim().length > 0) {
    const normalized = normalizeScopePath(storedPath);
    if (isBindableMatchAnyFilePointer(normalized, declared, projectRoot)) {
      return { ok: true, path: normalized };
    }
    return {
      ok: false,
      kind: "undeclared-binding",
      detail: `${storedPath} is not a non-glob matchAny file under plan.metadata.swarm.file_scope`,
    };
  }
  const tokens = extractPathTokens(text);
  const hits = uniqueMatchAnyFileHits(tokens, declared, text, projectRoot);
  if (hits.length === 1) {
    return { ok: true, path: hits[0] ?? null };
  }
  if (hits.length > 1) {
    return {
      ok: false,
      kind: "ambiguous-scope",
      detail: `names more than one file_scope member: ${hits.join(", ")}`,
    };
  }
  if (tokens.length > 0) {
    return {
      ok: false,
      kind: "unbound-path",
      detail: `names ${tokens.join(", ")} which is not a non-glob matchAny file under file_scope`,
    };
  }
  return { ok: true, path: null };
}

function bindOneClause(
  clause: AcceptanceClause,
  declared: readonly string[],
  projectRoot: string,
):
  | { readonly ok: true; readonly clause: AcceptanceClause; readonly changed: boolean }
  | { readonly ok: false; readonly failure: ClauseBindFailure } {
  const readings = clause.readings;
  if (readings !== undefined && readings.length > 0) {
    const boundReadings: AcceptanceClauseReading[] = [];
    let changed = false;
    for (const reading of readings) {
      const result = bindStoredOrTokens(reading.artifact_path, reading.text, declared, projectRoot);
      if (result.ok === false) {
        return {
          ok: false,
          failure: {
            id: clause.id,
            text: clause.text,
            kind: result.kind,
            detail: result.detail,
          },
        };
      }
      if (result.path !== reading.artifact_path) {
        changed = true;
      }
      boundReadings.push({ text: reading.text, artifact_path: result.path });
    }
    const chosen = clause.chosen_reading ?? 0;
    const chosenPath =
      boundReadings[chosen]?.artifact_path ?? boundReadings[0]?.artifact_path ?? null;
    if (chosenPath !== clause.artifact_path) {
      changed = true;
    }
    return {
      ok: true,
      changed,
      clause: {
        ...clause,
        artifact_path: chosenPath,
        readings: boundReadings,
      },
    };
  }
  const result = bindStoredOrTokens(clause.artifact_path, clause.text, declared, projectRoot);
  if (result.ok === false) {
    return {
      ok: false,
      failure: {
        id: clause.id,
        text: clause.text,
        kind: result.kind,
        detail: result.detail,
      },
    };
  }
  return {
    ok: true,
    changed: result.path !== clause.artifact_path,
    clause: { ...clause, artifact_path: result.path },
  };
}

function formatBindFailures(failures: readonly ClauseBindFailure[]): string {
  const lines = [
    "Refusing promote: a derived clause is not bound to a declared file_scope path (#4008).",
  ];
  for (const failure of failures) {
    lines.push(`  clause ${failure.id}: ${failure.detail}`);
  }
  lines.push(
    "  remedy: set artifact_path to a non-glob file that matchAny(file_scope) accepts, or name that file in the clause. Glob-shaped pointers and directory stand-ins are refused. Basename matching is refused.",
  );
  return lines.join("\n");
}

/**
 * Bind derived clauses to non-glob `matchAny` files under file_scope (#4008 / #4840).
 *
 * Empty declared scope is a no-op: there is no approved member to bind to.
 * Glob-shaped stored paths, extracted tokens, and declared-member text hits
 * are refused. A matchAny path becomes `artifact_path` even when the file is
 * still missing (promotion-time future file). Existing directories are not
 * copied. Stamp and walk still require a contained regular file. Basename
 * matching stays refused.
 */
export function bindClausesToDeclaredScope(
  clauses: readonly AcceptanceClause[],
  declaredScope: readonly string[],
  projectRoot: string,
): ClauseFileScopeBindResult {
  const declared = declaredScope
    .map((entry) => normalizeScopePath(entry))
    .filter((entry) => entry.length > 0);
  if (declared.length === 0 || clauses.length === 0) {
    return { ok: true, changed: false, clauses, failures: [], message: "" };
  }
  const next: AcceptanceClause[] = [];
  const failures: ClauseBindFailure[] = [];
  let changed = false;
  let boundCount = 0;
  for (const clause of clauses) {
    const bound = bindOneClause(clause, declared, projectRoot);
    if (bound.ok === false) {
      failures.push(bound.failure);
      next.push(clause);
      continue;
    }
    if (bound.changed) {
      changed = true;
    }
    if (bound.clause.artifact_path !== null) {
      boundCount += 1;
    }
    next.push(bound.clause);
  }
  if (failures.length > 0) {
    return {
      ok: false,
      changed: false,
      clauses,
      failures,
      message: formatBindFailures(failures),
    };
  }
  return {
    ok: true,
    changed,
    clauses: next,
    failures: [],
    message: changed
      ? `bound ${boundCount} clause(s) to plan.metadata.swarm.file_scope (#4008)`
      : "",
  };
}

/**
 * Quoted literals a clause asks the walk to find verbatim in the artifact.
 *
 * Apostrophe and double-quote are separate delimiter classes. An apostrophe
 * immediately after alphanumeric is a possessive or contraction, not a quote
 * opener. Pairing those as one class captured fragments that cannot exist
 * in the artifact and false-FAILED correct work (#4103).
 */
export function extractExpectedTokens(clause: AcceptanceClause): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  const patterns = [/"([^"\n]{3,80})"/g, /(?<![A-Za-z0-9])'([^'\n]{3,80})'/g];
  for (const quoted of patterns) {
    let match = quoted.exec(clause.text);
    while (match !== null) {
      const token = (match[1] ?? "").trim();
      const skip =
        token.length === 0 ||
        token === clause.artifact_path ||
        looksLikeFilePath(token) ||
        seen.has(token);
      if (!skip) {
        seen.add(token);
        tokens.push(token);
      }
      match = quoted.exec(clause.text);
    }
  }
  return tokens;
}

function walkOne(
  clause: AcceptanceClause,
  projectRoot: string,
  declaredScope: readonly string[],
): ClauseWalkResult {
  const artifactPath = clause.artifact_path;
  if (artifactPath === null || artifactPath.trim().length === 0) {
    return {
      id: clause.id,
      text: clause.text,
      artifact_path: artifactPath,
      outcome: "unverifiable",
      detail: "no artifact path bound",
      adjudicable: false,
    };
  }
  // #3835: every filesystem touch below this line — existence, stat, and the
  // token read — is gated here. A path the brief did not declare is refused
  // before the walk learns anything about it, and the refusal detail is a
  // function of the path alone, so a rejected clause reports the same thing
  // whatever needle it carries. Filtering the shape of the path upstream was
  // measured to narrow this by zero; this is the line that closes it.
  if (!isDeclaredArtifactPath(artifactPath, declaredScope)) {
    return {
      id: clause.id,
      text: clause.text,
      artifact_path: artifactPath,
      outcome: "unverifiable",
      detail:
        `artifact path is not declared on plan.metadata.swarm.file_scope, so nothing ` +
        `was read: ${artifactPath} (#3835)`,
      adjudicable: false,
    };
  }
  // Past the declared-scope gate the walk has an oracle, so every outcome below
  // counts toward the `ok` predicate.
  const bound = (outcome: ClauseOutcome, detail: string): ClauseWalkResult => ({
    id: clause.id,
    text: clause.text,
    artifact_path: artifactPath,
    outcome,
    detail,
    adjudicable: true,
  });
  if (isScratchArtifactPath(artifactPath)) {
    return bound("failed", "artifact path is a buffer/scratch copy, not the shipped path");
  }
  const abs = resolve(projectRoot, artifactPath);
  if (!isContained(projectRoot, abs)) {
    return bound("failed", "artifact path escaped the project root");
  }
  if (!existsSync(abs)) {
    if (NEGATED_EXISTENCE.test(clause.text)) {
      // #3826: absence is not evidence. The negation phrase is matched against the
      // whole clause text, so on a derived clause it routinely refers to something
      // other than the bound path — a bare `git.ts` in analysis prose passed here
      // and was the sole `verified` row propping up the `ok` predicate on #3794.
      return bound(
        "unverifiable",
        `artifact absent at ${artifactPath}; a prose negation is not evidence ` +
          `the clause requires this path to be absent (#3826)`,
      );
    }
    return bound("failed", `artifact missing at stated path ${artifactPath}`);
  }
  try {
    if (!statSync(abs).isFile()) {
      return bound("failed", `stated path is not a shipped file: ${artifactPath}`);
    }
  } catch {
    return bound("failed", `artifact unreadable at stated path ${artifactPath}`);
  }
  if (isBoundArtifactAbsenceClaim(clause.text, artifactPath)) {
    return bound("failed", `artifact exists at ${artifactPath} but the clause requires absence`);
  }
  const expected = extractExpectedTokens(clause);
  if (expected.length > 0) {
    let body = "";
    try {
      body = readFileSync(abs, "utf8");
    } catch {
      return bound("failed", `artifact unreadable at stated path ${artifactPath}`);
    }
    const missing = expected.filter((token) => !body.includes(token));
    if (missing.length > 0) {
      return bound(
        "failed",
        `expected token(s) missing from ${artifactPath}: ${missing.join(", ")}`,
      );
    }
    return bound("verified", `tokens present in shipped artifact ${artifactPath}`);
  }
  if (EXISTENCE_CLAIM.test(clause.text)) {
    return bound("verified", `shipped artifact exists at ${artifactPath}`);
  }
  // #4240: a declared path is not an oracle for a behavioral claim with no
  // extractable tokens and no existence claim. Treat it like unbound:
  // unverifiable, not adjudicable. failed === 0 is the strongest static verdict.
  // Absence of THIS bound artifact is recognized above. Whole-clause
  // negation that names some other subject is behavioral, not an oracle.
  return {
    id: clause.id,
    text: clause.text,
    artifact_path: artifactPath,
    outcome: "unverifiable",
    detail: `cannot evaluate behavioral claim against shipped artifact ${artifactPath}`,
    adjudicable: false,
  };
}

/**
 * Clauses the walk had an oracle for — bound to a declared artifact path.
 *
 * A clause with no oracle can only ever be `unverifiable`, so requiring a positive
 * `verified` from a set of them is unsatisfiable by correct work rather than a
 * quality bar (#3826).
 */
export function countAdjudicableClauses(rows: readonly ClauseWalkResult[]): number {
  return rows.filter((row) => row.adjudicable).length;
}

/**
 * Adjudicable clauses the walk did not verify.
 *
 * #3826 made `verified > 0` a *set* predicate excused by an empty oracle set, so
 * one bound-and-verified clause re-armed the whole set and covered siblings with
 * their own unmet oracle. Counting per clause is what removes that seam (#3835).
 */
export function countUnverifiedAdjudicableClauses(rows: readonly ClauseWalkResult[]): number {
  return rows.filter((row) => row.adjudicable && row.outcome !== "verified").length;
}

/** Verify-walk cause when a brief sentence is neither a clause nor a confession (#3550). */
export const UNMAPPED_STATEMENT_SENTENCE_CAUSE = "unmapped_statement_sentence" as const;

function isSentenceTerminator(ch: string): boolean {
  return ch === "." || ch === "!" || ch === "?";
}

/** Drop heading and list markers. The sentence stays text; it does not select a file. */
function stripSentenceChrome(raw: string): string {
  let text = stripInlineMarkdownBold(raw).replace(/\s+/g, " ").trim();
  for (let guard = 0; guard < 4 && text.length > 0; guard += 1) {
    const heading = /^(#{1,6}) (.+)$/.exec(text);
    if (heading !== null) {
      text = (heading[2] ?? "").trim();
      continue;
    }
    const bullet = /^(?:[-*+]|\d{1,3}[.)])\s+(.+)$/.exec(text);
    if (bullet !== null) {
      text = (bullet[1] ?? "").trim();
      continue;
    }
    break;
  }
  return text;
}

/**
 * Prose sentences in a task statement. Text only. A sentence does not select
 * a file, and a terminator inside a token (`probe.txt`) is not a boundary (#3550).
 */
export function extractStatementSentences(text: string): string[] {
  const source = stripFencedCodeBlocks(text);
  const out: string[] = [];
  const seen = new Set<string>();
  let start = 0;
  let index = 0;
  while (index < source.length) {
    const ch = source[index] ?? "";
    if (!isSentenceTerminator(ch)) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < source.length && isSentenceTerminator(source[end] ?? "")) {
      end += 1;
    }
    const next = source[end] ?? "";
    const boundary = end >= source.length || /\s/.test(next);
    if (!boundary) {
      index += 1;
      continue;
    }
    const sentence = stripSentenceChrome(source.slice(start, end));
    if (/[A-Za-z]/.test(sentence)) {
      const key = sentence.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(sentence);
      }
    }
    index = end;
    while (index < source.length && /\s/.test(source[index] ?? "")) {
      index += 1;
    }
    start = index;
  }
  return out;
}

/**
 * Coverage of `plan.acceptance.sentences` against clause text and confessions.
 * Text only. A sentence does not select a file (#3550).
 */
export interface StatementSentenceCoverage {
  readonly hasSentenceList: boolean;
  readonly sentences: readonly string[];
  readonly unmapped: readonly string[];
  readonly behavioralClauseCount: number;
  readonly unmappedSentenceCount: number;
}

function readNonEmptyStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const out: string[] = [];
  for (const entry of value) {
    if (!isNonEmptyString(entry)) {
      return null;
    }
    out.push(normalizeClauseText(entry));
  }
  return out;
}

function isExistenceOrQuotedTokenClause(clause: AcceptanceClause): boolean {
  if (extractExpectedTokens(clause).length > 0) {
    return true;
  }
  return EXISTENCE_CLAIM.test(clause.text) && !NEGATED_EXISTENCE.test(clause.text);
}

function countBehavioralClauses(clauses: readonly AcceptanceClause[]): number {
  return clauses.filter((clause) => !isExistenceOrQuotedTokenClause(clause)).length;
}

/**
 * A statement sentence is covered only when its text is a clause or an explicit
 * confession on the same acceptance block. Existence and quoted-token clauses
 * do not cover a different sentence (#3550).
 */
export function evaluateStatementSentenceCoverage(
  acceptance: unknown,
  clauses: readonly AcceptanceClause[],
): StatementSentenceCoverage {
  const behavioralClauseCount = countBehavioralClauses(clauses);
  const rec = asRecord(acceptance);
  if (rec === null || !Object.hasOwn(rec, "sentences")) {
    return {
      hasSentenceList: false,
      sentences: [],
      unmapped: [],
      behavioralClauseCount,
      unmappedSentenceCount: 0,
    };
  }
  const sentences = readNonEmptyStringList(rec.sentences);
  if (sentences === null) {
    return {
      hasSentenceList: false,
      sentences: [],
      unmapped: [],
      behavioralClauseCount,
      unmappedSentenceCount: 0,
    };
  }
  const confessions =
    rec.confessions === undefined ? [] : (readNonEmptyStringList(rec.confessions) ?? []);
  const clauseTexts = new Set(clauses.map((clause) => normalizeClauseText(clause.text)));
  const confessionTexts = new Set(confessions);
  const unmapped = sentences.filter((text) => !clauseTexts.has(text) && !confessionTexts.has(text));
  return {
    hasSentenceList: true,
    sentences,
    unmapped,
    behavioralClauseCount,
    unmappedSentenceCount: unmapped.length,
  };
}

/** Schema errors for the sentence list and confessions. Absent fields are valid. */
export function acceptanceSentenceListErrors(acceptance: unknown): string[] {
  const rec = asRecord(acceptance);
  if (rec === null) {
    return [];
  }
  const errors: string[] = [];
  if (
    "sentences" in rec &&
    rec.sentences !== undefined &&
    readNonEmptyStringList(rec.sentences) === null
  ) {
    errors.push("plan.acceptance.sentences must be an array of non-empty strings");
  }
  if (
    "confessions" in rec &&
    rec.confessions !== undefined &&
    readNonEmptyStringList(rec.confessions) === null
  ) {
    errors.push("plan.acceptance.confessions must be an array of non-empty strings");
  }
  return errors;
}

export function walkAcceptanceClauses(
  clauses: readonly AcceptanceClause[],
  projectRoot: string,
  options: ClauseWalkOptions,
): ClauseWalkReport {
  const walked = clauses.map((clause) => walkOne(clause, projectRoot, options.declaredScope));
  const failed = walked.filter((row) => row.outcome === "failed");
  const unverifiable = walked.filter((row) => row.outcome === "unverifiable");
  const verified = walked.filter((row) => row.outcome === "verified");
  const ok = failed.length === 0 && countUnverifiedAdjudicableClauses(walked) === 0;
  return {
    clauses: walked,
    failed,
    unverifiable,
    verified,
    ok,
    message: formatClauseWalkMessage({
      clauses: walked,
      failed,
      unverifiable,
      verified,
      ok,
      message: "",
    }),
  };
}

function formatOne(row: ClauseWalkResult): string {
  const path = row.artifact_path ?? "(no path)";
  return `  [${row.outcome}] clause ${row.id} @ ${path}: ${row.text} — ${row.detail}`;
}

/** Done reports lead with failed/unverifiable; unverifiable is never dropped. */
export function formatClauseWalkMessage(
  report: Omit<ClauseWalkReport, "message"> & { readonly message?: string },
  prior?: string,
): string {
  const lead = [...report.failed, ...report.unverifiable];
  const rest = report.verified;
  const lines = [
    `verify:ac clause walk (#3323): ${report.verified.length} verified, ` +
      `${report.unverifiable.length} unverifiable, ${report.failed.length} failed`,
    ...lead.map(formatOne),
    ...rest.map(formatOne),
  ];
  const body = lines.join("\n");
  if (prior !== undefined && prior.trim().length > 0) {
    return `${body}\n${prior}`;
  }
  return body;
}
