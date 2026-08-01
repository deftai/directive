import { WINDOW_RADIUS } from "./constants.js";
import type { Hit } from "./types.js";

export const CLOSING_KEYWORD_RE =
  /\b(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+#(\d+)\b/gi;

const NEGATION_MARKERS: readonly RegExp[] = [
  /\bnot\s+/i,
  /n't\s+/i,
  /\bnever\s+/i,
  /\bintentionally\s+not\s+/i,
  /\bdoes\s+not\b/i,
  /\bdo\s+not\b/i,
  /\bwon't\b/i,
  /\bcannot\b/i,
  /\bWITHOUT\b/,
  /\bEXCEPT\b/,
];

const QUOTE_MARKERS: readonly string[] = ["`", "'", '"', "\u2018", "\u2019", "\u201c", "\u201d"];

const EXAMPLE_MARKERS: readonly RegExp[] = [
  /\be\.g\./i,
  /\bi\.e\./i,
  /\bfor\s+example\b/i,
  /\bsuch\s+as\b/i,
  /\blike\b/i,
];

const BLOCKQUOTE_RE = /^\s*>\s/m;
const CODE_FENCE_RE = /^```/m;

function findAllMatches(text: string, re: RegExp): RegExpExecArray[] {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const pattern = new RegExp(re.source, flags);
  const matches: RegExpExecArray[] = [];
  let m: RegExpExecArray | null = pattern.exec(text);
  while (m !== null) {
    matches.push(m);
    m = pattern.exec(text);
  }
  return matches;
}

function lineStartingAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  let lineEnd = text.indexOf("\n", offset);
  if (lineEnd === -1) {
    lineEnd = text.length;
  }
  return text.slice(lineStart, lineEnd);
}

function isInsideCodeFence(text: string, offset: number): boolean {
  // Count ALL fence openers before offset (must use /g — a non-global match only
  // sees the first fence and permanently classifies the rest of the body as inside).
  const prefix = text.slice(0, offset);
  const re = new RegExp(CODE_FENCE_RE.source, "gm");
  let count = 0;
  let m: RegExpExecArray | null = re.exec(prefix);
  while (m !== null) {
    count += 1;
    m = re.exec(prefix);
  }
  return count % 2 === 1;
}

function classifyHit(text: string, match: RegExpExecArray): string | null {
  const start = match.index ?? 0;
  const end = start + match[0].length;

  if (isInsideCodeFence(text, start)) {
    return "code-block";
  }

  const line = lineStartingAt(text, start);
  if (BLOCKQUOTE_RE.test(line)) {
    return "blockquote";
  }

  const winStart = Math.max(0, start - WINDOW_RADIUS);
  const winEnd = Math.min(text.length, end + WINDOW_RADIUS);
  const window = text.slice(winStart, winEnd);
  const kwOffset = start - winStart;

  for (const negation of NEGATION_MARKERS) {
    for (const m of findAllMatches(window, negation)) {
      if (m.index !== undefined && m.index + m[0].length <= kwOffset) {
        return "negation";
      }
    }
  }

  const pre = text.slice(Math.max(0, start - 3), start);
  const post = text.slice(end, Math.min(text.length, end + 3));
  if (QUOTE_MARKERS.some((q) => pre.includes(q)) && QUOTE_MARKERS.some((q) => post.includes(q))) {
    return "quotation";
  }
  if (pre.includes("`") && post.includes("`")) {
    return "quotation";
  }

  for (const example of EXAMPLE_MARKERS) {
    for (const m of findAllMatches(window, example)) {
      if (m.index !== undefined && m.index + m[0].length <= kwOffset) {
        return "example";
      }
    }
  }

  return null;
}

export function renderHit(hit: Hit): string {
  return (
    `  [${hit.source}] ${hit.reason}: ` +
    `"...${hit.context}..." -> ${hit.keyword} #${hit.issueNumber}`
  );
}

function snippetAround(text: string, match: RegExpExecArray): string {
  const snippetStart = Math.max(0, (match.index ?? 0) - 30);
  const snippetEnd = Math.min(text.length, (match.index ?? 0) + match[0].length + 30);
  return text.slice(snippetStart, snippetEnd).replace(/\n/g, " ");
}

/** Layer 0 FP hits only (#737): keyword in negation / quotation / example / code-block / blockquote. */
export function findHits(text: string, source: string): Hit[] {
  const hits: Hit[] = [];
  const re = new RegExp(CLOSING_KEYWORD_RE.source, CLOSING_KEYWORD_RE.flags);
  let match: RegExpExecArray | null = re.exec(text);
  while (match !== null) {
    const category = classifyHit(text, match);
    if (category !== null) {
      hits.push({
        source,
        keyword: match[1] ?? "",
        issueNumber: Number(match[2]),
        context: snippetAround(text, match),
        reason: category,
      });
    }
    match = re.exec(text);
  }
  return hits;
}

/**
 * Intent-mode hits (#3015 class D): every closing-keyword + `#N` match, regardless of
 * surrounding prose. GitHub closes on token presence; conditional English is ignored.
 * reason is the FP category when present, otherwise `intent`.
 */
export function findAllClosingKeywordHits(text: string, source: string): Hit[] {
  const hits: Hit[] = [];
  const re = new RegExp(CLOSING_KEYWORD_RE.source, CLOSING_KEYWORD_RE.flags);
  let match: RegExpExecArray | null = re.exec(text);
  while (match !== null) {
    const category = classifyHit(text, match);
    hits.push({
      source,
      keyword: match[1] ?? "",
      issueNumber: Number(match[2]),
      context: snippetAround(text, match),
      reason: category ?? "intent",
    });
    match = re.exec(text);
  }
  return hits;
}

/**
 * Machine trailer on a dedicated **last non-empty line** of the PR body
 * (not commit messages): `deft-close-intent: full` allows real closing keywords
 * in intent mode (#3015). Rejects code fences, blockquotes, quotation wrappers,
 * and mid-body example lines with content after them.
 *
 * Horizontal whitespace only (`[ \\t]`) — never `\\s`, which would let `^\\s*`
 * swallow a preceding blank line and mis-locate the trailer boundary.
 */
export const CLOSE_INTENT_FULL_RE = /^[ \t]*deft-close-intent[ \t]*:[ \t]*full[ \t]*$/gim;

/** Markdown indented code block: 4+ spaces or a leading tab (CommonMark). */
function isIndentedCodeLine(line: string): boolean {
  return /^(?: {4,}|\t)/.test(line);
}

export function hasFullCloseIntent(text: string): boolean {
  const re = new RegExp(CLOSE_INTENT_FULL_RE.source, CLOSE_INTENT_FULL_RE.flags);
  let match: RegExpExecArray | null = re.exec(text);
  while (match !== null) {
    const start = match.index ?? 0;
    if (!isInsideCodeFence(text, start)) {
      const line = lineStartingAt(text, start);
      // Bare trailer only: no blockquote (compact `>` or `> `), indented code, or quotes.
      // Use /^[ \t]*>/ — BLOCKQUOTE_RE requires space after `>` and misses `>marker`.
      if (!/^[ \t]*>/.test(line) && !isIndentedCodeLine(line)) {
        const trimmed = line.trim();
        const wrappedInQuotes =
          trimmed.length >= 2 &&
          QUOTE_MARKERS.some((q) => trimmed.startsWith(q) && trimmed.endsWith(q));
        if (!wrappedInQuotes) {
          // True trailer: only whitespace may follow the marker line.
          const lineEnd = text.indexOf("\n", start);
          const after = lineEnd === -1 ? "" : text.slice(lineEnd + 1);
          if (after.trim().length === 0) {
            return true;
          }
        }
      }
    }
    match = re.exec(text);
  }
  return false;
}
