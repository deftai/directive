/**
 * Lines Directive wrote into shared customer files for the retired copied
 * `.deft/core` layout, and the helpers that remove exactly those lines
 * (AC8.10 / #5961).
 *
 * These lines were written before any ownership record existed, so this table
 * is how setup recognises them (AC11.2 "supported-layout knowledge"). Every
 * helper removes only exact Directive lines and leaves every other line, key
 * and file in place. Helpers never create a file and never delete one.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { assertDestinationNotSymlink } from "../fs/projection-containment.js";

const RETIRED_CORE_GLOB = ".deft/core/**";

/** `.gitattributes` lines the copied-layout writer deposited (#1430 / #5245 / #5463). */
export const RETIRED_COPY_MODEL_GITATTRIBUTES_LINES: readonly string[] = [
  `${RETIRED_CORE_GLOB} text=auto eol=lf`,
  `${RETIRED_CORE_GLOB} linguist-generated=true`,
  `${RETIRED_CORE_GLOB} linguist-vendored=true`,
  `${RETIRED_CORE_GLOB} text eol=lf`,
];

/** Starts of the comment lines written above the retired `.gitattributes` lines. */
const RETIRED_GITATTRIBUTES_COMMENT_PREFIXES: readonly string[] = [
  "# Deft framework: the vendored payload is packaged framework code",
  "# consumer source. text=auto + eol=lf normalizes text only",
  "# byte identity",
];

/** True for a comment line Directive wrote above the retired `.gitattributes` lines. */
export function isRetiredGitattributesCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return RETIRED_GITATTRIBUTES_COMMENT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/** True for a retired `.gitattributes` line or its comment. */
export function isRetiredGitattributesLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    RETIRED_COPY_MODEL_GITATTRIBUTES_LINES.includes(trimmed) ||
    isRetiredGitattributesCommentLine(trimmed)
  );
}

/** `.prettierignore` entries that covered the copied layout (#2534). */
export const RETIRED_PRETTIERIGNORE_LINES: readonly string[] = [
  ".deft/core/",
  ".deft/core",
  ".deft/core/**",
];

/** Header Directive wrote above the retired `.prettierignore` entry (#2534). */
export const RETIRED_PRETTIERIGNORE_HEADER =
  "# Deft framework: the vendored payload is outside the consumer Prettier gate (#2534).";

/** `greptile.json` `ignorePatterns` line for the copied layout. */
export const RETIRED_GREPTILE_PATTERN = RETIRED_CORE_GLOB;

export const CODEQL_CONFIG_REL = ".github/codeql/codeql-config.yml";

/** CodeQL `paths-ignore` items for the copied layout (every quote form Directive accepted). */
const RETIRED_CODEQL_ITEMS: readonly string[] = [
  `- '${RETIRED_CORE_GLOB}'`,
  `- "${RETIRED_CORE_GLOB}"`,
  `- ${RETIRED_CORE_GLOB}`,
];

/** Comment lines Directive wrote at the top of a CodeQL config it created (#1430). */
const RETIRED_CODEQL_COMMENTS: readonly string[] = [
  "# Deft framework: exclude the vendored payload from CodeQL analysis (#1430).",
  "# .deft/core/** is packaged framework code, not consumer source.",
];

/** Line-ending style of a text file (CRLF when any CRLF is present). */
function eolOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** Split text into lines without line endings; `trailing` tells whether it ended with one. */
function splitLines(text: string): { lines: string[]; trailing: boolean } {
  const norm = text.replace(/\r\n/g, "\n");
  const trailing = norm.endsWith("\n");
  const lines = norm.length === 0 ? [] : norm.split("\n");
  if (trailing) lines.pop();
  return { lines, trailing };
}

function joinLines(lines: readonly string[], eol: string, trailing: boolean): string {
  if (lines.length === 0) return "";
  return lines.join(eol) + (trailing ? eol : "");
}

/** Drop blank lines left at the end after a removal. */
function trimTrailingBlankLines(lines: readonly string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && (out[out.length - 1] ?? "").trim() === "") out.pop();
  return out;
}

/** `.prettierignore` text without the retired entry and its header; null when unchanged. */
export function stripRetiredPrettierIgnore(text: string): string | null {
  const { lines, trailing } = splitLines(text);
  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    return (
      !RETIRED_PRETTIERIGNORE_LINES.includes(trimmed) && trimmed !== RETIRED_PRETTIERIGNORE_HEADER
    );
  });
  if (kept.length === lines.length) return null;
  return joinLines(trimTrailingBlankLines(kept), eolOf(text), trailing);
}

/**
 * `greptile.json` text without the retired `ignorePatterns` line; null when
 * unchanged or when the file cannot be edited safely. Only the
 * `ignorePatterns` string changes: every other byte of the file stays.
 */
export function stripRetiredGreptileIgnore(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const patterns = (parsed as Record<string, unknown>).ignorePatterns;
  if (typeof patterns !== "string") return null;
  const parts = patterns.split("\n");
  const kept = parts.filter((part) => part.trim() !== RETIRED_GREPTILE_PATTERN);
  if (kept.length === parts.length) return null;
  // Replace the `ignorePatterns` value literal in place, as written in the
  // source (any escaping), so key order and formatting stay.
  const spans = ignorePatternsValueSpans(text).filter((span) => {
    try {
      return JSON.parse(text.slice(span.start, span.end)) === patterns;
    } catch {
      return false;
    }
  });
  const span = spans.length === 1 ? spans[0] : undefined;
  if (span === undefined) return null;
  return text.slice(0, span.start) + JSON.stringify(kept.join("\n")) + text.slice(span.end);
}

/** Source spans of every string value written after an `"ignorePatterns":` key. */
function ignorePatternsValueSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const key = /"ignorePatterns"\s*:\s*"/g;
  for (let m = key.exec(text); m !== null; m = key.exec(text)) {
    const start = m.index + m[0].length - 1;
    let i = start + 1;
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    if (i < text.length) spans.push({ start, end: i + 1 });
  }
  return spans;
}

/**
 * CodeQL config text without the retired `paths-ignore` item and Directive's
 * two comment lines; null when unchanged. A `paths-ignore:` key left with no
 * items after the removal goes too, because an empty key is not a list.
 */
export function stripRetiredCodeqlConfig(text: string): string | null {
  const { lines, trailing } = splitLines(text);
  const out: string[] = [];
  let changed = false;
  let blockStart = -1;
  let blockItems = 0;
  let blockRemoved = 0;
  const closeBlock = (): void => {
    if (blockStart >= 0 && blockItems === 0 && blockRemoved > 0) {
      out.splice(blockStart, 1);
    }
    blockStart = -1;
    blockItems = 0;
    blockRemoved = 0;
  };
  for (const line of lines) {
    const startsAtColumnZero = line.length > 0 && line[0] !== " " && line[0] !== "\t";
    if (startsAtColumnZero && RETIRED_CODEQL_COMMENTS.includes(line.trimEnd())) {
      changed = true;
      continue;
    }
    // Comments and unindented `- item` lines stay inside the list; only a new
    // key ends it.
    const topLevel = startsAtColumnZero && !line.startsWith("#") && !line.startsWith("-");
    if (topLevel) {
      closeBlock();
      if (line.trimEnd() === "paths-ignore:") blockStart = out.length;
      out.push(line);
      continue;
    }
    if (blockStart >= 0 && RETIRED_CODEQL_ITEMS.includes(line.trim())) {
      changed = true;
      blockRemoved += 1;
      continue;
    }
    if (blockStart >= 0 && line.trim().startsWith("-")) blockItems += 1;
    out.push(line);
  }
  closeBlock();
  if (!changed) return null;
  return joinLines(out, eolOf(text), trailing);
}

/** Files {@link removeRetiredCopyModelLines} may edit, project-relative. */
export const RETIRED_COPY_MODEL_LINE_FILES: readonly string[] = [
  ".prettierignore",
  "greptile.json",
  CODEQL_CONFIG_REL,
];

const STRIPPERS: Readonly<Record<string, (text: string) => string | null>> = {
  ".prettierignore": stripRetiredPrettierIgnore,
  "greptile.json": stripRetiredGreptileIgnore,
  [CODEQL_CONFIG_REL]: stripRetiredCodeqlConfig,
};

/**
 * Remove the retired copied-layout lines from `.prettierignore`,
 * `greptile.json` and the CodeQL config (AC8.10). Files are kept even when
 * nothing else is left in them. Returns the project-relative paths changed.
 */
export function removeRetiredCopyModelLines(projectRoot: string): string[] {
  const root = resolve(projectRoot);
  const changed: string[] = [];
  for (const rel of RETIRED_COPY_MODEL_LINE_FILES) {
    const target = join(root, rel);
    if (!existsSync(target)) continue;
    assertDestinationNotSymlink(root, target);
    let text: string;
    try {
      text = readFileSync(target, "utf8");
    } catch {
      continue;
    }
    const strip = STRIPPERS[rel];
    const next = strip === undefined ? null : strip(text);
    if (next === null || next === text) continue;
    containedWrite({ root, target, data: next, mode: "replace" });
    changed.push(rel);
  }
  return changed;
}

/** The one `.prettierignore` line for Directive's committed hook files (AC13.3). */
export const PRETTIERIGNORE_HOOK_FILES_LINE = "**/deft-hook-*.mjs";

/** Header above {@link PRETTIERIGNORE_HOOK_FILES_LINE} (AC13.3). */
export const PRETTIERIGNORE_MANAGED_HEADER =
  "# Deft managed wiring: Directive's committed hook files are not formatted (AC13.3).";

/**
 * `.prettierignore` text with the hook-file line under the managed header;
 * null when the line is already there (AC13.3).
 */
export function addPrettierIgnoreHookLine(text: string): string | null {
  const { lines } = splitLines(text);
  if (lines.some((line) => line.trim() === PRETTIERIGNORE_HOOK_FILES_LINE)) return null;
  const eol = eolOf(text);
  const headerAt = lines.findIndex((line) => line.trim() === PRETTIERIGNORE_MANAGED_HEADER);
  let out: string[];
  if (headerAt >= 0) {
    out = [
      ...lines.slice(0, headerAt + 1),
      PRETTIERIGNORE_HOOK_FILES_LINE,
      ...lines.slice(headerAt + 1),
    ];
    return joinLines(out, eol, true);
  }
  out = [...lines];
  if (out.length > 0 && (out[out.length - 1] ?? "").trim() !== "") out.push("");
  out.push(PRETTIERIGNORE_MANAGED_HEADER, PRETTIERIGNORE_HOOK_FILES_LINE);
  return joinLines(out, eol, true);
}

/**
 * Add the hook-file line to an existing root `.prettierignore` (AC13.3).
 * Never creates the file. Returns true when it wrote.
 */
export function ensurePrettierIgnoreHookLine(projectRoot: string): boolean {
  const root = resolve(projectRoot);
  const target = join(root, ".prettierignore");
  if (!existsSync(target)) return false;
  assertDestinationNotSymlink(root, target);
  const next = addPrettierIgnoreHookLine(readFileSync(target, "utf8"));
  if (next === null) return false;
  containedWrite({ root, target, data: next, mode: "replace" });
  return true;
}
