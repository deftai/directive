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
  const prefix = text.slice(0, offset);
  const matches = prefix.match(CODE_FENCE_RE);
  return matches !== null && matches.length % 2 === 1;
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

export function findHits(text: string, source: string): Hit[] {
  const hits: Hit[] = [];
  const re = new RegExp(CLOSING_KEYWORD_RE.source, CLOSING_KEYWORD_RE.flags);
  let match: RegExpExecArray | null = re.exec(text);
  while (match !== null) {
    const category = classifyHit(text, match);
    if (category !== null) {
      const snippetStart = Math.max(0, (match.index ?? 0) - 30);
      const snippetEnd = Math.min(text.length, (match.index ?? 0) + match[0].length + 30);
      const context = text.slice(snippetStart, snippetEnd).replace(/\n/g, " ");
      hits.push({
        source,
        keyword: match[1] ?? "",
        issueNumber: Number(match[2]),
        context,
        reason: category,
      });
    }
    match = re.exec(text);
  }
  return hits;
}
