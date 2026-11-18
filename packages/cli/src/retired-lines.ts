/**
 * Lines Directive wrote into shared customer files, and their removal on
 * uninstall (#6007 / AC8.10 / AC11.5 / AC13.3).
 *
 * Covers `.gitattributes`, `.prettierignore`, `greptile.json` and
 * `.github/codeql/codeql-config.yml`. Removes only exact lines Directive
 * wrote (the retired `.deft/core` lines from the copied-content layout and
 * the current `# Deft managed wiring:` block); every other line stays
 * byte-identical and the files are never deleted.
 *
 * Node builtins only: the launcher cannot import core (AC3.1). The tables
 * mirror core `init-deposit/scaffold.ts` and `init-deposit/prettierignore.ts`;
 * `retired-lines.test.ts` fails when core writes a line this
 * table does not know.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Core `CORE_GLOB`: the retired copied-content folder. */
const CORE_GLOB = ".deft/core/**";

/** Header of the block setup writes today (AC11.10: reuse the existing marker). */
export const MANAGED_WIRING_MARKER = "# Deft managed wiring:";

/** Retired copied-content attribute lines (core `CORE_GITATTRIBUTES_LINES` + legacy). */
const RETIRED_GITATTRIBUTES_LINES = [
  `${CORE_GLOB} text=auto eol=lf`,
  `${CORE_GLOB} linguist-generated=true`,
  `${CORE_GLOB} linguist-vendored=true`,
  `${CORE_GLOB} text eol=lf`,
] as const;

/** Core `MANAGED_WIRING_GITATTRIBUTES_LINES` (#5995). */
const MANAGED_WIRING_GITATTRIBUTES_LINES = [
  ".claude/commands/** text=auto eol=lf",
  ".cursor/commands/** text=auto eol=lf",
  ".grok/commands/** text=auto eol=lf",
  ".codex/prompts/** text=auto eol=lf",
  ".agents/skills/** text=auto eol=lf",
  ".claude/skills/** text=auto eol=lf",
  ".cursor/skills/** text=auto eol=lf",
  ".codex/skills/** text=auto eol=lf",
  ".github/skills/** text=auto eol=lf",
  ".githooks/** text=auto eol=lf",
  ".grok/hooks/** text=auto eol=lf",
  "AGENTS.md text=auto eol=lf",
] as const;

/** Every comment line core `gitattributesDepositComment` can write. */
const GITATTRIBUTES_COMMENT_LINES = [
  "# Deft framework: the vendored payload is packaged framework code, not",
  "# consumer source. text=auto + eol=lf normalizes text only; binaries keep",
  "# byte identity. Mark generated + vendored (#1430, #2118, #5245).",
  "# byte identity (#5245).",
  "# Deft managed wiring: pin Directive-deposited host/command/hook/skill paths",
  "# to LF so Windows core.autocrlf checkouts stay ownership-comparable (#5995).",
] as const;

/** `.prettierignore` lines: the retired `.deft/core/` entry and the AC13.3 hook-file line. */
const PRETTIERIGNORE_LINES = [
  ".deft/core/",
  "# Deft framework: the vendored payload is outside the consumer Prettier gate (#2534).",
  "**/deft-hook-*.mjs",
] as const;

export type DirectiveLineFile = ".gitattributes" | ".prettierignore";

/** Directive lines per line file. */
export const DIRECTIVE_WRITTEN_LINES: Readonly<Record<DirectiveLineFile, ReadonlySet<string>>> = {
  ".gitattributes": new Set<string>([
    ...RETIRED_GITATTRIBUTES_LINES,
    ...MANAGED_WIRING_GITATTRIBUTES_LINES,
    ...GITATTRIBUTES_COMMENT_LINES,
  ]),
  ".prettierignore": new Set<string>(PRETTIERIGNORE_LINES),
};

/** The `.deft/core/**` entry core `ensureGreptileIgnore` appends to `ignorePatterns`. */
export const GREPTILE_RETIRED_PATTERN = CORE_GLOB;

export const CODEQL_CONFIG_REL = ".github/codeql/codeql-config.yml";

/** The `paths-ignore` item core writes, in the three quote forms it accepts. */
const CODEQL_RETIRED_ITEMS: ReadonlySet<string> = new Set([
  `- '${CORE_GLOB}'`,
  `- "${CORE_GLOB}"`,
  `- ${CORE_GLOB}`,
]);

/** Comment lines core `codeqlConfigDefault` writes. */
const CODEQL_COMMENT_LINES: ReadonlySet<string> = new Set([
  "# Deft framework: exclude the vendored payload from CodeQL analysis (#1430).",
  "# .deft/core/** is packaged framework code, not consumer source.",
]);

export interface WrittenLinesReport {
  readonly modified: string[];
  readonly leftovers: string[];
  readonly uncertainty: string[];
}

interface SplitText {
  readonly lines: string[];
  readonly eol: "\n" | "\r\n";
  readonly finalNewline: boolean;
}

function splitText(body: string): SplitText {
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const finalNewline = body.endsWith("\n");
  const lines = body.split("\n").map((l) => l.replace(/\r$/, ""));
  if (finalNewline) lines.pop();
  return { lines, eol, finalNewline };
}

function joinText(lines: readonly string[], eol: string, finalNewline: boolean): string {
  if (lines.length === 0) return "";
  return lines.join(eol) + (finalNewline ? eol : "");
}

/**
 * Drop the marked lines, plus the one blank line Directive put above a
 * removed block when nothing (or another blank line) follows the block.
 */
function dropMarked(lines: readonly string[], marked: readonly boolean[]): string[] {
  const drop = [...marked];
  let i = 0;
  while (i < lines.length) {
    if (!marked[i]) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < lines.length && marked[i]) i += 1;
    const before = start - 1;
    const atEnd = i >= lines.length;
    if (
      before >= 0 &&
      !drop[before] &&
      (lines[before] ?? "").trim() === "" &&
      (atEnd || (lines[i] ?? "").trim() === "")
    ) {
      drop[before] = true;
    }
  }
  return lines.filter((_, idx) => !drop[idx]);
}

/**
 * Remove Directive's exact lines from a line file. A `# Deft managed wiring:`
 * header and the comment lines right under it go too when every line it
 * introduces (up to the next blank line) is Directive's. Other lines stay
 * byte-identical.
 */
export function stripDirectiveLines(
  body: string,
  directive: ReadonlySet<string>,
): { next: string; removed: boolean } {
  const { lines, eol, finalNewline } = splitText(body);
  const marked = lines.map((l) => directive.has(l.trim()));
  for (let i = 0; i < lines.length; i += 1) {
    if (!(lines[i] ?? "").trim().startsWith(MANAGED_WIRING_MARKER)) continue;
    let j = i + 1;
    while (j < lines.length && (lines[j] ?? "").trim().startsWith("#")) j += 1;
    let k = j;
    while (k < lines.length && (lines[k] ?? "").trim() !== "" && marked[k]) k += 1;
    if (k < lines.length && (lines[k] ?? "").trim() !== "") continue;
    for (let m = i; m < j; m += 1) marked[m] = true;
  }
  if (!marked.some(Boolean)) return { next: body, removed: false };
  return { next: joinText(dropMarked(lines, marked), eol, finalNewline), removed: true };
}

/** Remove `.deft/core/**` from a newline-separated Greptile `ignorePatterns` value. */
export function stripGreptilePatterns(patterns: string): { next: string; removed: boolean } {
  const parts = patterns.split("\n");
  const kept = parts.filter((p) => p.trim() !== GREPTILE_RETIRED_PATTERN);
  if (kept.length === parts.length) return { next: patterns, removed: false };
  return { next: kept.join("\n"), removed: true };
}

/**
 * Remove Directive's `paths-ignore` item and comment lines from a CodeQL
 * config. Drops the `paths-ignore:` key too when Directive's item was its only one.
 */
export function stripCodeqlConfig(body: string): { next: string; removed: boolean } {
  const { lines, eol, finalNewline } = splitText(body);
  const marked = lines.map((l) => CODEQL_COMMENT_LINES.has(l.trim()));
  for (let i = 0; i < lines.length; i += 1) {
    if ((lines[i] ?? "").trimEnd() !== "paths-ignore:") continue;
    let j = i + 1;
    let ours = 0;
    let others = 0;
    while (j < lines.length) {
      const line = lines[j] ?? "";
      if (line.length > 0 && line[0] !== " " && line[0] !== "\t") break;
      if (CODEQL_RETIRED_ITEMS.has(line.trim())) {
        marked[j] = true;
        ours += 1;
      } else if (line.trim() !== "") {
        others += 1;
      }
      j += 1;
    }
    if (ours > 0 && others === 0) marked[i] = true;
  }
  if (!marked.some(Boolean)) return { next: body, removed: false };
  return { next: joinText(dropMarked(lines, marked), eol, finalNewline), removed: true };
}

/**
 * Remove `.deft/core/**` from `greptile.json` `ignorePatterns`, editing only
 * that string value so every other key and line stays byte-identical.
 * `unsafe` when the file is not a JSON object or the value cannot be found once.
 */
export function stripGreptileJson(raw: string): { next: string; removed: boolean } | "unsafe" {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "unsafe";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "unsafe";
  const patterns = (parsed as Record<string, unknown>).ignorePatterns;
  if (typeof patterns !== "string") return { next: raw, removed: false };
  const stripped = stripGreptilePatterns(patterns);
  if (!stripped.removed) return { next: raw, removed: false };
  const oldLiteral = JSON.stringify(patterns);
  const at = raw.indexOf(oldLiteral);
  if (at < 0 || raw.indexOf(oldLiteral, at + 1) >= 0) return "unsafe";
  const next = raw.slice(0, at) + JSON.stringify(stripped.next) + raw.slice(at + oldLiteral.length);
  return { next, removed: true };
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Planned edits: file → new body, plus files that hold Directive lines we cannot edit safely. */
function planEdits(projectRoot: string): { edits: Map<string, string>; unsafe: string[] } {
  const edits = new Map<string, string>();
  const unsafe: string[] = [];
  for (const rel of [".gitattributes", ".prettierignore"] as const) {
    const body = readText(join(projectRoot, rel));
    if (body === null) continue;
    const { next, removed } = stripDirectiveLines(body, DIRECTIVE_WRITTEN_LINES[rel]);
    if (removed) edits.set(rel, next);
  }
  const greptile = readText(join(projectRoot, "greptile.json"));
  if (greptile !== null) {
    const result = stripGreptileJson(greptile);
    if (result === "unsafe") {
      if (greptile.includes(GREPTILE_RETIRED_PATTERN)) unsafe.push("greptile.json");
    } else if (result.removed) {
      edits.set("greptile.json", result.next);
    }
  }
  const codeql = readText(join(projectRoot, CODEQL_CONFIG_REL));
  if (codeql !== null) {
    const { next, removed } = stripCodeqlConfig(codeql);
    if (removed) edits.set(CODEQL_CONFIG_REL, next);
  }
  return { edits, unsafe };
}

/** Files that still hold a line Directive wrote (plan and completion check). */
export function filesWithDirectiveLines(projectRoot: string): string[] {
  const { edits, unsafe } = planEdits(projectRoot);
  return [...edits.keys(), ...unsafe];
}

/**
 * Remove the lines Directive wrote into `.gitattributes`, `.prettierignore`,
 * `greptile.json` and the CodeQL config (AC8.10 / AC13.3). Never deletes the
 * files. `write` is the caller's contained write; false means it refused.
 */
export function removeDirectiveWrittenLines(
  projectRoot: string,
  write: (rel: string, body: string) => boolean,
): WrittenLinesReport {
  const modified: string[] = [];
  const leftovers: string[] = [];
  const uncertainty: string[] = [];
  const { edits, unsafe } = planEdits(projectRoot);
  for (const [rel, next] of edits) {
    if (write(rel, next)) {
      modified.push(`${rel}#directive-lines`);
    } else {
      leftovers.push(`${rel} (Directive lines)`);
      uncertainty.push(`could not rewrite ${rel}`);
    }
  }
  for (const rel of unsafe) {
    leftovers.push(`${rel} (Directive lines)`);
    uncertainty.push(`${rel} could not be edited safely; left untouched`);
  }
  return { modified, leftovers, uncertainty };
}
