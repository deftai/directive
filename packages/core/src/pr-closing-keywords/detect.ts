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
/** CommonMark fenced code opener/closer at line start: 3+ backticks or 3+ tildes. */
const CODE_FENCE_LINE_RE = /^(?:`{3,}|~{3,})/;

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

/**
 * CommonMark fence stack: open and close must use the same character, and the
 * closer length must be >= opener length. Mixed ``` / ~~~ or shorter closers
 * do not pop the open fence.
 */
function isInsideCodeFence(text: string, offset: number): boolean {
  let openChar: "`" | "~" | null = null;
  let openLen = 0;
  let lineStart = 0;
  while (lineStart < offset) {
    let lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd === -1 || lineEnd > offset) {
      lineEnd = Math.min(text.length, offset);
    }
    const line = text.slice(lineStart, lineEnd);
    const m = CODE_FENCE_LINE_RE.exec(line);
    if (m !== null) {
      const fence = m[0] ?? "";
      const ch = fence[0] as "`" | "~";
      const len = fence.length;
      if (openChar === null) {
        openChar = ch;
        openLen = len;
      } else if (ch === openChar && len >= openLen) {
        openChar = null;
        openLen = 0;
      }
    }
    if (lineEnd >= offset) {
      break;
    }
    lineStart = lineEnd + 1;
  }
  return openChar !== null;
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

/**
 * Single-char ECMAScript `\s` probe (no quantifier). Used by the monotonic
 * comma-list tail scanner so CodeQL `js/polynomial-redos` alert #121 stays clear.
 */
const WS_CHAR = /\s/;

function isWs(ch: string | undefined): boolean {
  return ch !== undefined && WS_CHAR.test(ch);
}

/**
 * One-keyword comma-list tails: `Closes #4204, #4218, #4161`.
 *
 * Linear monotonic walk — replaces `/(?:\s*,\s*#(\d+))+/y` (CodeQL alert #121 /
 * #5745). Each iteration advances past `,`, `#`, and at least one digit; optional
 * ECMAScript whitespace around the comma is scanned once. Stops at the first
 * malformed segment and returns the valid prefix only (no silent truncation of
 * long valid tails). Forward progress is O(n) in the remaining text length.
 */
function commaListIssueIds(text: string, after: number): number[] {
  const ids: number[] = [];
  let i = after;
  while (i < text.length) {
    const segmentStart = i;
    while (i < text.length && isWs(text[i])) {
      i += 1;
    }
    if (i >= text.length || text[i] !== ",") {
      break;
    }
    i += 1;
    while (i < text.length && isWs(text[i])) {
      i += 1;
    }
    if (i >= text.length || text[i] !== "#") {
      break;
    }
    i += 1;
    const digitStart = i;
    while (i < text.length) {
      const ch = text[i] as string;
      if (ch < "0" || ch > "9") {
        break;
      }
      i += 1;
    }
    if (i === digitStart) {
      break;
    }
    ids.push(Number(text.slice(digitStart, i)));
    // Unreachable under normal progress; keeps the loop strictly monotonic.
    if (i <= segmentStart) {
      break;
    }
  }
  return ids;
}

function collectClosingHits(text: string, source: string, fpOnly: boolean): Hit[] {
  const hits: Hit[] = [];
  const re = new RegExp(CLOSING_KEYWORD_RE.source, CLOSING_KEYWORD_RE.flags);
  let match: RegExpExecArray | null = re.exec(text);
  while (match !== null) {
    const category = classifyHit(text, match);
    const reason = category ?? "intent";
    if (!fpOnly || category !== null) {
      hits.push({
        source,
        keyword: match[1] ?? "",
        issueNumber: Number(match[2]),
        context: snippetAround(text, match),
        reason: fpOnly ? (category as string) : reason,
      });
      const start = match.index ?? 0;
      for (const issueNumber of commaListIssueIds(text, start + match[0].length)) {
        hits.push({
          source,
          keyword: match[1] ?? "",
          issueNumber,
          context: snippetAround(text, match),
          reason: fpOnly ? (category as string) : reason,
        });
      }
    }
    match = re.exec(text);
  }
  return hits;
}

/** Layer 0 FP hits only (#737): keyword in negation / quotation / example / code-block / blockquote. */
export function findHits(text: string, source: string): Hit[] {
  return collectClosingHits(text, source, true);
}

/**
 * Intent-mode hits (#3015 class D): every closing-keyword + `#N` match, regardless of
 * surrounding prose. GitHub closes on token presence; conditional English is ignored.
 * reason is the FP category when present, otherwise `intent`.
 * Comma-list tails (`Closes #4204, #4218, …`) count as additional origins (#4494).
 */
export function findAllClosingKeywordHits(text: string, source: string): Hit[] {
  return collectClosingHits(text, source, false);
}

/**
 * Body trailer `deft-close-intent: full` is intentionally NOT an authorization path.
 * Intent-mode allowlist is CLI `--allow-close N,M` only (#3015 / Greptile class-D gate).
 * Markdown examples must never suppress real closing-keyword findings.
 */
export function hasFullCloseIntent(_text: string): boolean {
  return false;
}
