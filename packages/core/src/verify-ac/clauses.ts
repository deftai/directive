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

function buildClause(id: number, text: string): AcceptanceClause {
  const paths = extractPathTokens(text);
  if (paths.length <= 1) {
    return {
      id,
      text,
      artifact_path: paths[0] ?? null,
      ambiguous: false,
    };
  }
  const readings: AcceptanceClauseReading[] = paths.map((artifact_path) => ({
    text: `${text} [reading: ${artifact_path}]`,
    artifact_path,
  }));
  return {
    id,
    text,
    artifact_path: paths[0] ?? null,
    ambiguous: true,
    readings,
    chosen_reading: 0,
  };
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

function walkOne(clause: AcceptanceClause, projectRoot: string): ClauseWalkResult {
  const artifactPath = clause.artifact_path;
  if (artifactPath === null || artifactPath.trim().length === 0) {
    return {
      id: clause.id,
      text: clause.text,
      artifact_path: artifactPath,
      outcome: "unverifiable",
      detail: "no artifact path bound",
    };
  }
  if (isScratchArtifactPath(artifactPath)) {
    return {
      id: clause.id,
      text: clause.text,
      artifact_path: artifactPath,
      outcome: "failed",
      detail: "artifact path is a buffer/scratch copy, not the shipped path",
    };
  }
  const abs = resolve(projectRoot, artifactPath);
  if (!isContained(projectRoot, abs)) {
    return {
      id: clause.id,
      text: clause.text,
      artifact_path: artifactPath,
      outcome: "failed",
      detail: "artifact path escaped the project root",
    };
  }
  if (!existsSync(abs)) {
    if (NEGATED_EXISTENCE.test(clause.text)) {
      // #3826: absence is not evidence. The negation phrase is matched against the
      // whole clause text, so on a derived clause it routinely refers to something
      // other than the bound path — a bare `git.ts` in analysis prose passed here
      // and was the sole `verified` row propping up the `ok` predicate on #3794.
      return {
        id: clause.id,
        text: clause.text,
        artifact_path: artifactPath,
        outcome: "unverifiable",
        detail:
          `artifact absent at ${artifactPath}; a prose negation is not evidence ` +
          `the clause requires this path to be absent (#3826)`,
      };
    }
    return {
      id: clause.id,
      text: clause.text,
      artifact_path: artifactPath,
      outcome: "failed",
      detail: `artifact missing at stated path ${artifactPath}`,
    };
  }
  try {
    if (!statSync(abs).isFile()) {
      return {
        id: clause.id,
        text: clause.text,
        artifact_path: artifactPath,
        outcome: "failed",
        detail: `stated path is not a shipped file: ${artifactPath}`,
      };
    }
  } catch {
    return {
      id: clause.id,
      text: clause.text,
      artifact_path: artifactPath,
      outcome: "failed",
      detail: `artifact unreadable at stated path ${artifactPath}`,
    };
  }
  if (NEGATED_EXISTENCE.test(clause.text)) {
    return {
      id: clause.id,
      text: clause.text,
      artifact_path: artifactPath,
      outcome: "failed",
      detail: `artifact exists at ${artifactPath} but the clause requires absence`,
    };
  }
  const expected = extractExpectedTokens(clause);
  if (expected.length > 0) {
    let body = "";
    try {
      body = readFileSync(abs, "utf8");
    } catch {
      return {
        id: clause.id,
        text: clause.text,
        artifact_path: artifactPath,
        outcome: "failed",
        detail: `artifact unreadable at stated path ${artifactPath}`,
      };
    }
    const missing = expected.filter((token) => !body.includes(token));
    if (missing.length > 0) {
      return {
        id: clause.id,
        text: clause.text,
        artifact_path: artifactPath,
        outcome: "failed",
        detail: `expected token(s) missing from ${artifactPath}: ${missing.join(", ")}`,
      };
    }
    return {
      id: clause.id,
      text: clause.text,
      artifact_path: artifactPath,
      outcome: "verified",
      detail: `tokens present in shipped artifact ${artifactPath}`,
    };
  }
  if (EXISTENCE_CLAIM.test(clause.text)) {
    return {
      id: clause.id,
      text: clause.text,
      artifact_path: artifactPath,
      outcome: "verified",
      detail: `shipped artifact exists at ${artifactPath}`,
    };
  }
  return {
    id: clause.id,
    text: clause.text,
    artifact_path: artifactPath,
    outcome: "unverifiable",
    detail: `cannot evaluate behavioral claim against shipped artifact ${artifactPath}`,
  };
}

/**
 * Clauses the walk has any oracle for — i.e. bound to an artifact path (#3826).
 *
 * A clause with no bound path can only ever be `unverifiable`, so requiring a
 * positive `verified` from a set of them is unsatisfiable by correct work rather
 * than a quality bar. `verified > 0` binds only where this count is non-zero.
 */
export function countAdjudicableClauses(rows: readonly ClauseWalkResult[]): number {
  return rows.filter((row) => (row.artifact_path ?? "").trim().length > 0).length;
}

export function walkAcceptanceClauses(
  clauses: readonly AcceptanceClause[],
  projectRoot: string,
): ClauseWalkReport {
  const walked = clauses.map((clause) => walkOne(clause, projectRoot));
  const failed = walked.filter((row) => row.outcome === "failed");
  const unverifiable = walked.filter((row) => row.outcome === "unverifiable");
  const verified = walked.filter((row) => row.outcome === "verified");
  const ok =
    failed.length === 0 &&
    (verified.length > 0 || walked.length === 0 || countAdjudicableClauses(walked) === 0);
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
