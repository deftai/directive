/**
 * Citation grammar for the design-critique completed-arc record (#3831).
 *
 * One parser answers both questions the ingest predicate asks: which comment
 * ids a synthesis cites, and whether it claims a verified-claims table. The
 * closed accepted set and the refused positions are published in
 * `content/contracts/design-critique.md` `## Citation grammar`; this module is
 * the only implementation of that grammar.
 *
 * Which code-span convention governs. The intake cross-ref scanners
 * (`intake/markdown-scanners.ts`) delete code spans, so for them a backticked
 * id is an example and never a reference. The citation scan takes the opposite
 * polarity for the id token only: a balanced single-backtick id is an accepted
 * citation, because arc comments are hand-written prose and the mandated lean
 * heading is itself `**Lean:**`. A keyword inside a code span or a fence stays
 * an example in both layers. Positions are classified, never stripped -- the
 * strippers delete a span with its contents, which destroys the digits. The
 * prior art for classify-not-strip is `classifyHit`
 * (`pr-closing-keywords/detect.ts`).
 *
 * The fence scan is local rather than borrowed from that detector because the
 * detector's opener regex is anchored at column zero, so a CommonMark fence
 * indented one to three spaces reads as prose. Relaxing it there would move
 * hits into the #737 false-positive class and change what that gate suppresses,
 * which is a separate decision from this one.
 */

export type CitationKind = "lean" | "table" | "comment";

export type CitationRejectionClass =
  | "code-fence"
  | "inline-code"
  | "blockquote"
  | "strikethrough"
  | "negation";

export type Citation = {
  readonly id: number;
  readonly kind: CitationKind;
};

export type RejectedCitation = {
  readonly id: number;
  readonly reason: CitationRejectionClass;
};

export type CitationScan = {
  /** Accepted citations in document order, deduplicated on (id, kind). */
  readonly citations: readonly Citation[];
  /** Keyword-anchored or permalink occurrences refused by position. */
  readonly rejected: readonly RejectedCitation[];
  /** Every 8-or-more digit run in the body, for deterministic diagnostics. */
  readonly idShapedRuns: readonly number[];
};

/** The published closed set, in the order the contract lists it. */
export const ACCEPTED_CITATION_FORMS: readonly string[] = [
  "successor lean 12345678",
  "successor lean: 12345678",
  "successor lean `12345678`",
  "**successor lean:** 12345678",
  "#issuecomment-12345678",
  "/issues/comments/12345678",
];

const EMPHASIS = "(?:\\*\\*|\\*)";
const KEYWORD = "(successor[ \\t]+lean|verified-claims[ \\t]+table|lean|comment)";
/**
 * Colon and horizontal whitespace only. One of the three branches must consume
 * a colon or a space, so `lean12345678` is not a citation.
 */
const SEPARATOR = `(?::${EMPHASIS}?[ \\t]*|${EMPHASIS}:?[ \\t]+|[ \\t]+)`;
/** Bare decimal, or a balanced single-backtick decimal. Nothing else. */
const ID_TOKEN = "(?:`(\\d{8,})`|(\\d{8,})\\b)";

const CITATION_RE = new RegExp(
  `${EMPHASIS}?\\b${KEYWORD}${SEPARATOR}${ID_TOKEN}` +
    "|#issuecomment-(\\d{8,})" +
    "|/issues/comments/(\\d{8,})",
  "gi",
);

const ID_RUN_RE = /\d{8,}/g;

const BLOCKQUOTE_RE = /^ {0,3}>/;

/** CommonMark fence opener or closer: up to three leading spaces, then the run. */
const CODE_FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})/;

/** The last sentence break in a slice, and everything after it. */
const LAST_SENTENCE_RE = /[.!?;][^.!?;]*$/;

/**
 * Explicit negation of the citation itself, ending within three plain words of
 * the keyword. A bare marker anywhere in the sentence prefix is not enough: it
 * reads `without a doubt, successor lean N is accepted` and `not only successor
 * lean N but also the table` as refusals, which blocks a valid record.
 */
const NEGATED_CITATION_RE =
  /\b(?:cannot|never|no longer|(?:do|does|did|is|are|was|were|has|have|had|will|would|shall|should|must|can|could|may|might)\s+not|(?:do|does|did|is|are|was|were|has|have|had|wo|would|should|must|ca|could|sha)n['\u2019]t)\b(?:\s+[A-Za-z][A-Za-z'\u2019-]*){0,3}\s*$/i;

function kindForKeyword(keyword: string | undefined): CitationKind {
  if (keyword === undefined) return "comment";
  const normalized = keyword.toLowerCase().replace(/[ \t]+/g, " ");
  if (normalized.startsWith("verified-claims")) return "table";
  if (normalized === "comment") return "comment";
  return "lean";
}

function lineBounds(text: string, offset: number): { start: number; end: number } {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  const found = text.indexOf("\n", offset);
  return { start, end: found === -1 ? text.length : found };
}

/**
 * CommonMark inline code: a run of N backticks opens a span that only a run of
 * exactly N backticks closes. Counting single backticks would read a
 * double-backtick span as balanced and let documentation prose cite.
 */
function isInsideInlineCode(line: string, column: number): boolean {
  let openRun = 0;
  let i = 0;
  while (i < column) {
    if (line[i] !== "`") {
      i += 1;
      continue;
    }
    let run = 0;
    while (i + run < line.length && line[i + run] === "`") run += 1;
    if (openRun === 0) {
      openRun = run;
    } else if (run === openRun) {
      openRun = 0;
    }
    i += run;
  }
  return openRun !== 0;
}

function isStruckThrough(line: string, column: number): boolean {
  let runs = 0;
  let i = 0;
  while (i < column - 1) {
    if (line[i] === "~" && line[i + 1] === "~") {
      runs += 1;
      i += 2;
      continue;
    }
    i += 1;
  }
  return runs % 2 === 1;
}

/**
 * A negation binds the sentence it sits in, not the whole line. Scoping to the
 * text after the last sentence break keeps `this is not stale. Bound contract
 * is successor lean N` an affirmative citation.
 */
function isNegated(line: string, column: number): boolean {
  const before = line.slice(0, column);
  const tail = LAST_SENTENCE_RE.exec(before);
  const segment = tail === null ? before : before.slice(tail.index + 1);
  return NEGATED_CITATION_RE.test(segment);
}

/**
 * CommonMark fence stack. Opener and closer must use the same character and the
 * closer must be at least as long. A fence may be indented up to three spaces.
 */
function isInsideCodeFence(body: string, offset: number): boolean {
  let openChar: "`" | "~" | null = null;
  let openLen = 0;
  let lineStart = 0;
  while (lineStart < offset) {
    let lineEnd = body.indexOf("\n", lineStart);
    if (lineEnd === -1 || lineEnd > offset) {
      lineEnd = Math.min(body.length, offset);
    }
    const fence = CODE_FENCE_LINE_RE.exec(body.slice(lineStart, lineEnd));
    if (fence !== null) {
      const run = fence[1] ?? "";
      const char = run.startsWith("~") ? "~" : "`";
      if (openChar === null) {
        openChar = char;
        openLen = run.length;
      } else if (char === openChar && run.length >= openLen) {
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

function classifyPosition(body: string, offset: number): CitationRejectionClass | null {
  if (isInsideCodeFence(body, offset)) return "code-fence";
  const { start, end } = lineBounds(body, offset);
  const line = body.slice(start, end);
  const column = offset - start;
  if (BLOCKQUOTE_RE.test(line)) return "blockquote";
  if (isInsideInlineCode(line, column)) return "inline-code";
  if (isStruckThrough(line, column)) return "strikethrough";
  if (isNegated(line, column)) return "negation";
  return null;
}

function idShapedRuns(body: string): number[] {
  const runs: number[] = [];
  const seen = new Set<number>();
  const re = new RegExp(ID_RUN_RE.source, ID_RUN_RE.flags);
  for (const match of body.matchAll(re)) {
    const id = Number(match[0]);
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    runs.push(id);
  }
  return runs;
}

/**
 * Parse the closed citation grammar out of one comment body. Refused positions
 * are reported rather than dropped so a block detail can echo the observation
 * instead of guessing at a cause.
 */
export function scanCitations(body: string): CitationScan {
  const citations: Citation[] = [];
  const rejected: RejectedCitation[] = [];
  const seen = new Set<string>();
  const re = new RegExp(CITATION_RE.source, CITATION_RE.flags);
  for (const match of body.matchAll(re)) {
    const raw = match[2] ?? match[3] ?? match[4] ?? match[5];
    if (raw === undefined) continue;
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const reason = classifyPosition(body, match.index ?? 0);
    if (reason !== null) {
      rejected.push({ id, reason });
      continue;
    }
    const kind = kindForKeyword(match[1]);
    const key = `${id}|${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({ id, kind });
  }
  return { citations, rejected, idShapedRuns: idShapedRuns(body) };
}
