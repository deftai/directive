/**
 * Rung-2 derived AC: decompose the task statement into testable clauses
 * at intake; walk every clause against the shipped artifact at done (#3323).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { findAcHeading, parseListItems, sliceAcSection } from "../intake/markdown-scanners.js";

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
   * True when the walk had an oracle for this clause — a path the brief declared
   * on `plan.metadata.swarm.file_scope`. An unbound or undeclared clause can only
   * ever come back `unverifiable`, so it carries no weight either way (#3835).
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
const NEGATED_EXISTENCE =
  /\b(?:does not exist|doesn't exist|must not exist|never exists?|not exist)\b/i;

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
        const title = normalizeClauseText(item.title.replace(/\*\*/g, ""));
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
    const title = normalizeClauseText(item.title.replace(/\*\*/g, ""));
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
    const line = normalizeClauseText(source.replace(/\*\*/g, ""));
    const key = line.toLowerCase();
    if (line.length === 0 || isMetaClause(line) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    lines.push(line);
  }
  return lines;
}

export interface ClauseDerivationSources {
  /**
   * Declared acceptance lines from `plan.items`. When non-empty this IS the
   * derived clause set; the statement extractors below are the path for a brief
   * that declares no items (#3826).
   */
  readonly itemSurface?: readonly string[];
}

/** Acceptance lines the statement itself declares, in extractor precedence order. */
function collectStatementSurface(text: string): string[] {
  const raw: string[] = [];
  const acHeading = findAcHeading(text);
  if (acHeading !== null) {
    raw.push(
      ...parseListItems(sliceAcSection(text, acHeading))
        .map((item) => normalizeClauseText(item.title.replace(/\*\*/g, "")))
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
  // #3826: `plan.items` is a declared, body-scoped acceptance surface, while the
  // statement carries the whole untrusted issue comment thread. Preferring the
  // declared surface is what keeps an acceptance-shaped heading buried in that
  // thread from becoming the gate — the #3794 and #3819 mechanism.
  let raw: readonly string[] = itemSurface;
  if (raw.length === 0) {
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

/** True when the clause binding is a declared entry or sits under a declared directory. */
export function isDeclaredArtifactPath(
  artifactPath: string,
  declaredScope: readonly string[],
): boolean {
  const candidate = normalizeScopePath(artifactPath);
  if (candidate.length === 0 || candidate === ".." || candidate.startsWith("../")) {
    return false;
  }
  return declaredScope.some((raw) => {
    const entry = normalizeScopePath(raw);
    return entry.length > 0 && (candidate === entry || candidate.startsWith(`${entry}/`));
  });
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

function uniqueExactDeclaredHits(
  tokens: readonly string[],
  declared: readonly string[],
  text: string,
): string[] {
  const hits = new Set<string>();
  const members = new Set(declared);
  for (const token of tokens) {
    const normalized = normalizeScopePath(token);
    if (members.has(normalized)) {
      hits.add(normalized);
    }
  }
  for (const member of declared) {
    if (memberAppearsInText(text, member)) {
      hits.add(member);
    }
  }
  return [...hits];
}

function bindStoredOrTokens(
  storedPath: string | null,
  text: string,
  declared: readonly string[],
): BoundPathResult {
  if (storedPath !== null && storedPath.trim().length > 0) {
    const normalized = normalizeScopePath(storedPath);
    if (declared.includes(normalized)) {
      return { ok: true, path: normalized };
    }
    return {
      ok: false,
      kind: "undeclared-binding",
      detail: `${storedPath} is not an exact plan.metadata.swarm.file_scope member`,
    };
  }
  const tokens = extractPathTokens(text);
  const hits = uniqueExactDeclaredHits(tokens, declared, text);
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
      detail: `names ${tokens.join(", ")} which is not an exact file_scope member`,
    };
  }
  return { ok: true, path: null };
}

function bindOneClause(
  clause: AcceptanceClause,
  declared: readonly string[],
):
  | { readonly ok: true; readonly clause: AcceptanceClause; readonly changed: boolean }
  | { readonly ok: false; readonly failure: ClauseBindFailure } {
  const readings = clause.readings;
  if (readings !== undefined && readings.length > 0) {
    const boundReadings: AcceptanceClauseReading[] = [];
    let changed = false;
    for (const reading of readings) {
      const result = bindStoredOrTokens(reading.artifact_path, reading.text, declared);
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
  const result = bindStoredOrTokens(clause.artifact_path, clause.text, declared);
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
    "  remedy: set artifact_path to a plan.metadata.swarm.file_scope entry, or name that exact path in the clause. Basename matching is refused.",
  );
  return lines.join("\n");
}

/**
 * Bind derived clauses to exact `plan.metadata.swarm.file_scope` members (#4008).
 *
 * Empty declared scope is a no-op: there is no approved member to bind to.
 * Path tokens match only as exact normalized members — never by basename,
 * including stored `readings[]`. Derivation still stores no prose path; this
 * step copies the declared member onto the clause.
 */
export function bindClausesToDeclaredScope(
  clauses: readonly AcceptanceClause[],
  declaredScope: readonly string[],
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
    const bound = bindOneClause(clause, declared);
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

function isContained(root: string, child: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function extractExpectedTokens(clause: AcceptanceClause): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  const quoted = /["']([^"'\n]{3,80})["']/g;
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
  if (NEGATED_EXISTENCE.test(clause.text)) {
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
  return bound(
    "unverifiable",
    `cannot evaluate behavioral claim against shipped artifact ${artifactPath}`,
  );
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
