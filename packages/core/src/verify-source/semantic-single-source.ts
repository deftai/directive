/**
 * C2 — semantic single-source conformance (#3600 / #3899).
 *
 * Shipped guidance must name one value where the framework has one value.
 * The 0.6-versus-0.8 defect lives inside a file that resolves perfectly, so
 * pointer existence (C1) cannot see it. This oracle is not a link checker.
 *
 * Evaluates a staged pack root (flattened consumer deposit) or a source
 * checkout (content/ prefix + root main.md). Three-state: 0 clean / 1 drift / 2 config.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const EXIT_OK = 0;
const EXIT_DRIFT = 1;
const EXIT_CONFIG = 2;

/** Closed, typed current-authoring surfaces (#3600 AC / #3899 C2). */
export const C2_AUTHORING_SURFACES = [
  "main.md",
  "skills/deft-directive-setup/SKILL.md",
  "skills/deft-directive-build/SKILL.md",
  "skills/deft-directive-interview/SKILL.md",
  "skills/deft-directive-refinement/SKILL.md",
  "skills/deft-directive-sync/SKILL.md",
  "templates/project.md.template",
  "templates/make-spec.md",
  "conventions/references.md",
  "commands.md",
] as const;

export type C2AuthoringSurface = (typeof C2_AUTHORING_SURFACES)[number];

const REQUIRED_SURFACES: readonly C2AuthoringSurface[] = [
  "main.md",
  "skills/deft-directive-setup/SKILL.md",
  "skills/deft-directive-build/SKILL.md",
];

export interface SemanticSingleSourceViolation {
  readonly path: string;
  readonly line: number;
  readonly version: string;
  readonly excerpt: string;
}

export interface SemanticSingleSourceResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: "stdout" | "stderr";
  readonly setupWriteVersion: string | null;
  readonly violations: readonly SemanticSingleSourceViolation[];
  readonly currentWriteVersions: readonly string[];
}

const ENVELOPE_CONTEXT_RE =
  /xBRIEFInfo|vBRIEFInfo|schema version|envelope|new write|new xBRIEF|new vBRIEF|MUST emit|MUST use|MUST target|MUST write|version field equal|authoring format|write-path|write default|write-default/i;

const QUOTED_VERSION_RE = /["'](0\.\d+)["']/g;
const BARE_XBRIEF_VERSION_RE = /\b(?:xBRIEF|vBRIEF|xbrief)\s+`?(0\.\d+)`?/g;

const LEGACY_BOUND_RE =
  /legacy|read-accepted|read\/migration|migrate:xbrief|historical|until `?deft migrate|deprecated|compatibility only|read compatibility|obsolete 0\.5|migration\/read|read-only/i;

const MUST_NOT_RE = /^\s*(?:[-*]\s*)?⊗/;
const MUST_LINE_RE = /^\s*(?:[-*]\s*)?!|\bMUST\b/;
const CANONICAL_HEADING_RE = /schema version:\s*v?(0\.\d+)\s*\(canonical/i;
const ALL_BRIEFS_MUST_RE = /All (?:x|v)BRIEFs/i;

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Resolve a closed-list surface against a flattened pack root or a source
 * checkout (content/ prefix for everything except root harness main.md).
 */
export function resolveAuthoringSurface(packRoot: string, rel: string): string | null {
  const root = resolve(packRoot);
  const flat = join(root, rel);
  if (existsSync(flat)) {
    return flat;
  }
  if (rel !== "main.md") {
    const underContent = join(root, "content", rel);
    if (existsSync(underContent)) {
      return underContent;
    }
  }
  return null;
}

export function extractQuotedVersions(line: string): string[] {
  const found: string[] = [];
  QUOTED_VERSION_RE.lastIndex = 0;
  for (const match of line.matchAll(QUOTED_VERSION_RE)) {
    const v = match[1];
    if (v !== undefined) found.push(v);
  }
  BARE_XBRIEF_VERSION_RE.lastIndex = 0;
  for (const match of line.matchAll(BARE_XBRIEF_VERSION_RE)) {
    const v = match[1];
    if (v !== undefined) found.push(v);
  }
  const heading = CANONICAL_HEADING_RE.exec(line);
  if (heading?.[1] !== undefined) {
    found.push(heading[1]);
  }
  return found;
}

function isWriteMandateLine(line: string): boolean {
  if (MUST_NOT_RE.test(line)) return false;
  if (CANONICAL_HEADING_RE.test(line)) return true;
  if (ALL_BRIEFS_MUST_RE.test(line) && /MUST/i.test(line)) return true;
  if (!MUST_LINE_RE.test(line)) return false;
  return ENVELOPE_CONTEXT_RE.test(line) || CANONICAL_HEADING_RE.test(line);
}

const ENVELOPE_VERSION_RE =
  /(?:xBRIEFInfo|vBRIEFInfo)["']?\s*:\s*\{\s*["']version["']\s*:\s*["'](0\.\d+)["']/gi;

/** A version is legacy-bounded only from nearby clause text, not the whole line. */
function windowIsLegacyBound(line: string, index: number, length: number): boolean {
  const start = Math.max(0, index - 28);
  const end = Math.min(line.length, index + length + 72);
  return LEGACY_BOUND_RE.test(line.slice(start, end));
}

/** MUST use/emit/target/write with no open paren between the verb and the version. */
function isDirectMustVersion(line: string, index: number): boolean {
  return /MUST[ \t]+(?:use|emit|target|write)\b[^(]*$/i.test(line.slice(0, index));
}

function isInsideLegacyParen(line: string, index: number): boolean {
  const before = line.slice(0, index);
  const lastOpen = before.lastIndexOf("(");
  const lastClose = before.lastIndexOf(")");
  if (lastOpen <= lastClose) return false;
  const closeRel = line.slice(index).indexOf(")");
  const clause = line.slice(lastOpen, closeRel >= 0 ? index + closeRel : line.length);
  return LEGACY_BOUND_RE.test(clause);
}

function isLegacyBoundedOccurrence(line: string, index: number, length: number): boolean {
  if (isDirectMustVersion(line, index)) return false;
  if (isInsideLegacyParen(line, index)) return true;
  return windowIsLegacyBound(line, index, length);
}

function versionsOnMandate(line: string): { current: string[]; boundedLegacy: string[] } {
  const current: string[] = [];
  const boundedLegacy: string[] = [];
  const envelopeSpans: Array<{ start: number; end: number }> = [];

  ENVELOPE_VERSION_RE.lastIndex = 0;
  for (const match of line.matchAll(ENVELOPE_VERSION_RE)) {
    const v = match[1];
    const start = match.index ?? 0;
    if (v === undefined) continue;
    envelopeSpans.push({ start, end: start + match[0].length });
    current.push(v);
  }

  const heading = CANONICAL_HEADING_RE.exec(line);
  if (heading?.[1] !== undefined) {
    current.push(heading[1]);
  }

  const collect = (re: RegExp): void => {
    re.lastIndex = 0;
    for (const match of line.matchAll(re)) {
      const v = match[1];
      const start = match.index ?? 0;
      if (v === undefined) continue;
      if (envelopeSpans.some((s) => start >= s.start && start < s.end)) continue;
      if (isLegacyBoundedOccurrence(line, start, match[0].length)) {
        boundedLegacy.push(v);
      } else {
        current.push(v);
      }
    }
  };
  collect(QUOTED_VERSION_RE);
  collect(BARE_XBRIEF_VERSION_RE);
  return { current, boundedLegacy };
}

const SETUP_TEMPLATE_VERSION_RE =
  /["']xBRIEFInfo["']\s*:\s*\{[\s\S]{0,160}?["']version["']\s*:\s*["'](0\.\d+)["']/;

const SETUP_MUST_VERSION_RE = /MUST use\s+`?"xBRIEFInfo":\s*\{\s*"version":\s*"(0\.\d+)"/;

export function extractSetupWriteVersion(setupText: string): string | null {
  const text = normalizeText(setupText);
  const fromTemplate = SETUP_TEMPLATE_VERSION_RE.exec(text);
  if (fromTemplate?.[1] !== undefined) {
    return fromTemplate[1];
  }
  const fromMust = SETUP_MUST_VERSION_RE.exec(text);
  if (fromMust?.[1] !== undefined) {
    return fromMust[1];
  }
  return null;
}

function scanSurface(
  rel: string,
  text: string,
  setupWriteVersion: string,
): SemanticSingleSourceViolation[] {
  const violations: SemanticSingleSourceViolation[] = [];
  const lines = normalizeText(text).split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!isWriteMandateLine(line)) continue;
    const { current } = versionsOnMandate(line);
    for (const version of current) {
      if (version !== setupWriteVersion) {
        violations.push({
          path: rel,
          line: i + 1,
          version,
          excerpt: line.trim().slice(0, 160),
        });
      }
    }
  }
  return violations;
}

function collectCurrentWriteVersions(text: string): string[] {
  const found: string[] = [];
  const lines = normalizeText(text).split("\n");
  for (const line of lines) {
    if (!isWriteMandateLine(line)) continue;
    const { current } = versionsOnMandate(line);
    found.push(...current);
  }
  return found;
}

export function evaluateSemanticSingleSource(packRoot: string): SemanticSingleSourceResult {
  const root = resolve(packRoot);
  let isDir = false;
  try {
    isDir = statSync(root).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return {
      code: EXIT_CONFIG,
      message:
        `verify_semantic_single_source: --project-root is not a directory: ${root}\n` +
        "  Recovery: pass a staged pack root or framework checkout.",
      stream: "stderr",
      setupWriteVersion: null,
      violations: [],
      currentWriteVersions: [],
    };
  }

  const missingRequired: string[] = [];
  const resolved = new Map<string, string>();
  for (const rel of C2_AUTHORING_SURFACES) {
    const full = resolveAuthoringSurface(root, rel);
    if (full === null) {
      if ((REQUIRED_SURFACES as readonly string[]).includes(rel)) {
        missingRequired.push(rel);
      }
      continue;
    }
    resolved.set(rel, full);
  }
  if (missingRequired.length > 0) {
    return {
      code: EXIT_CONFIG,
      message:
        `verify_semantic_single_source: required authoring surface(s) missing under ${root}: ` +
        `${missingRequired.join(", ")}\n` +
        "  Recovery: stage the packed content (flattened) or pass the framework source root.",
      stream: "stderr",
      setupWriteVersion: null,
      violations: [],
      currentWriteVersions: [],
    };
  }

  const setupPath = resolved.get("skills/deft-directive-setup/SKILL.md");
  if (setupPath === undefined) {
    return {
      code: EXIT_CONFIG,
      message:
        "verify_semantic_single_source: setup skill missing (cannot read the write version).",
      stream: "stderr",
      setupWriteVersion: null,
      violations: [],
      currentWriteVersions: [],
    };
  }

  let setupText: string;
  try {
    setupText = readFileSync(setupPath, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      code: EXIT_CONFIG,
      message: `verify_semantic_single_source: failed to read setup skill: ${msg}`,
      stream: "stderr",
      setupWriteVersion: null,
      violations: [],
      currentWriteVersions: [],
    };
  }

  const setupWriteVersion = extractSetupWriteVersion(setupText);
  if (setupWriteVersion === null) {
    return {
      code: EXIT_DRIFT,
      message:
        "FAIL: C2 semantic single-source -- setup skill does not name a current xBRIEF write version.\n" +
        "  Expected a template or MUST using xBRIEFInfo.version (the version setup writes).",
      stream: "stderr",
      setupWriteVersion: null,
      violations: [],
      currentWriteVersions: [],
    };
  }

  const violations: SemanticSingleSourceViolation[] = [];
  const currentWriteVersions: string[] = [setupWriteVersion];
  for (const [rel, full] of resolved) {
    let text: string;
    try {
      text = readFileSync(full, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        code: EXIT_CONFIG,
        message: `verify_semantic_single_source: failed to read ${rel}: ${msg}`,
        stream: "stderr",
        setupWriteVersion,
        violations: [],
        currentWriteVersions: [],
      };
    }
    violations.push(...scanSurface(rel, text, setupWriteVersion));
    currentWriteVersions.push(...collectCurrentWriteVersions(text));
  }

  const uniqueCurrent = [...new Set(currentWriteVersions)];
  if (violations.length > 0 || uniqueCurrent.some((v) => v !== setupWriteVersion)) {
    const lines = [
      `FAIL: C2 semantic single-source -- shipped canon names more than one xBRIEF write version ` +
        `(setup writes ${setupWriteVersion}):`,
      ...violations.map(
        (v) => `  - ${v.path}:${v.line} names ${v.version}: ${v.excerpt.replace(/\r?\n/g, " ")}`,
      ),
      "  Recovery: current-authoring MUST lines must name only the version setup writes; " +
        "bound 0.6 to legacy/read/migration guidance.",
    ];
    return {
      code: EXIT_DRIFT,
      message: lines.join("\n"),
      stream: "stderr",
      setupWriteVersion,
      violations,
      currentWriteVersions: uniqueCurrent,
    };
  }

  const namedCurrent = uniqueCurrent.length === 1 && uniqueCurrent[0] === setupWriteVersion;
  if (!namedCurrent) {
    return {
      code: EXIT_DRIFT,
      message:
        "FAIL: C2 semantic single-source -- shipped canon does not name the version setup writes.\n" +
        `  Setup writes ${setupWriteVersion}; current-write MUST mandates found: [${uniqueCurrent.join(", ")}].`,
      stream: "stderr",
      setupWriteVersion,
      violations: [],
      currentWriteVersions: uniqueCurrent,
    };
  }

  return {
    code: EXIT_OK,
    message:
      `OK: C2 semantic single-source -- one xBRIEF write version ${setupWriteVersion.replace(/\r?\n/g, " ")} ` +
      `(setup writes ${setupWriteVersion.replace(/\r?\n/g, " ")}; ${resolved.size} authoring surface(s) scanned).`,
    stream: "stdout",
    setupWriteVersion,
    violations: [],
    currentWriteVersions: uniqueCurrent,
  };
}
