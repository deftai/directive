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

/** CommonMark fence delimiter: up to three leading spaces, the run, then the rest. */
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** The last sentence break in a slice, and everything after it. */
const LAST_SENTENCE_RE = /[.!?;][^.!?;]*$/;

/** Everything up to the first sentence break. */
const FIRST_SENTENCE_RE = /^[^.!?;]*/;

/** The closed set of explicit negation markers the class recognises. */
const NEGATION_MARKER =
  "\\b(?:cannot|never|no longer" +
  "|(?:do|does|did|is|are|was|were|has|have|had|will|would|shall|should|must|can|could|may|might)\\s+not" +
  "|(?:do|does|did|is|are|was|were|has|have|had|wo|would|should|must|ca|could|sha)n['\\u2019]t)\\b";

/**
 * Explicit negation of the citation itself, ending within three plain words of
 * the keyword. A bare marker anywhere in the sentence prefix is not enough: it
 * reads `without a doubt, successor lean N is accepted` and `not only successor
 * lean N but also the table` as refusals, which blocks a valid record.
 */
const NEGATED_CITATION_RE = new RegExp(
  `${NEGATION_MARKER}(?:\\s+[A-Za-z][A-Za-z'\\u2019-]*){0,3}\\s*$`,
  "i",
);

/** The same markers, unanchored, for the complement clause after a citation. */
const NEGATION_ANYWHERE_RE = new RegExp(NEGATION_MARKER, "i");

/**
 * A negated verb of denial affirms the citation rather than refusing it, so the
 * negation belongs to the verb and not to the occurrence: `we cannot deny that
 * successor lean N binds` cites N. The verb set is closed and published --
 * negating `deny`, `doubt`, `dispute`, `contest`, or `question` affirms the
 * complement clause those verbs introduce.
 *
 * A trailing `that` alone is not the signal, because `that` is also a
 * determiner. `do not use that successor lean N` and the cleft `the record is
 * not that successor lean N` are genuine refusals, and both keep the negation
 * class. The anchor is the end of the sentence segment, so a second negation
 * before the keyword still binds: `we do not doubt that this does not bind
 * successor lean N` is refused.
 *
 * The carve-out only suspends a prefix rule that already fired; it never
 * refuses on its own, so it cannot widen the refused set. It also does not
 * accept the citation outright. The complement clause is what carries the
 * claim, so a negation anywhere in the rest of that sentence keeps the refusal:
 * `we do not doubt that successor lean N does not bind` says the lean does not
 * bind. That scan runs to the sentence break rather than to a clause boundary,
 * which refuses more than it strictly must inside this one carve-out -- the
 * fail-closed direction, and every such body was already refused before it.
 */
const DENIAL_COMPLEMENT_RE =
  /\b(?:den(?:y|ies|ied|ying)|doubt(?:s|ed|ing)?|disput(?:e|es|ed|ing)|contest(?:s|ed|ing)?|question(?:s|ed|ing)?)\s+that\s*$/i;

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
 *
 * `text` is the whole span from the enclosing block start, not one line: a code
 * span may carry a newline, so a line-scoped count cannot see the opener.
 */
function isInsideInlineCode(text: string): boolean {
  let openRun = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "`") {
      i += 1;
      continue;
    }
    let run = 0;
    while (i + run < text.length && text[i + run] === "`") run += 1;
    if (openRun === 0) {
      openRun = run;
    } else if (run === openRun) {
      openRun = 0;
    }
    i += run;
  }
  return openRun !== 0;
}

function isStruckThrough(text: string): boolean {
  let runs = 0;
  let i = 0;
  while (i < text.length - 1) {
    if (text[i] === "~" && text[i + 1] === "~") {
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
  if (!NEGATED_CITATION_RE.test(segment)) return false;
  if (!DENIAL_COMPLEMENT_RE.test(segment)) return true;
  const after = line.slice(column);
  return NEGATION_ANYWHERE_RE.test(FIRST_SENTENCE_RE.exec(after)?.[0] ?? after);
}

type FenceDelimiter = {
  readonly char: "`" | "~";
  readonly len: number;
  readonly info: string;
};

function fenceDelimiter(line: string): FenceDelimiter | null {
  const match = FENCE_LINE_RE.exec(line);
  if (match === null) return null;
  const run = match[1] ?? "";
  const info = match[2] ?? "";
  const char = run.startsWith("~") ? "~" : "`";
  // A backtick opener's info string may not contain a backtick.
  if (char === "`" && info.includes("`")) return null;
  return { char, len: run.length, info };
}

type BlockPosition = {
  /** An unclosed fence encloses the offset. */
  readonly insideFence: boolean;
  /** Where inline scanning starts: after the last blank or fence line. */
  readonly inlineStart: number;
  /** A blockquote marker opened this block, so an unmarked line is lazy quoted text. */
  readonly quotedBlock: boolean;
};

/**
 * Walk the lines up to `offset` once and record both block facts the classifier
 * needs. The fence stack follows CommonMark: opener and closer share the
 * character, the closer is at least as long, and a closer carries no info
 * string, so `` ```ts more text `` inside an open fence is content and not a
 * closer. Inline scanning restarts after a blank line or a fence delimiter
 * because neither a code span nor a strikethrough run crosses one. A blockquote
 * marker carries forward to the blank line that ends the quote, so an unmarked
 * lazy-continuation line is still quoted text.
 *
 * A fence delimiter also ends the quote block, and a line inside an open fence
 * never opens one: a `>` in a fenced example is example text, so the marker must
 * not survive the closing fence and refuse the citation that follows it. Lazy
 * continuation is a paragraph rule, and a fence line is not paragraph text. A
 * fence marked by `>` on every line is not a fence here -- `fenceDelimiter`
 * requires the run at the line start -- so the line-level blockquote test still
 * refuses a citation inside a blockquoted fence.
 */
function blockPosition(body: string, offset: number): BlockPosition {
  let open: FenceDelimiter | null = null;
  let inlineStart = 0;
  let quotedBlock = false;
  let lineStart = 0;
  while (lineStart < offset) {
    let lineEnd = body.indexOf("\n", lineStart);
    const partial = lineEnd === -1 || lineEnd > offset;
    if (partial) {
      lineEnd = Math.min(body.length, offset);
    }
    const line = body.slice(lineStart, lineEnd);
    const fence = fenceDelimiter(line);
    if (fence !== null) {
      if (open === null) {
        open = fence;
      } else if (
        fence.char === open.char &&
        fence.len >= open.len &&
        fence.info.trim().length === 0
      ) {
        open = null;
      }
    }
    if (!partial) {
      const blank = line.trim().length === 0;
      if (blank || fence !== null) {
        inlineStart = lineEnd + 1;
        quotedBlock = false;
      } else if (open === null && BLOCKQUOTE_RE.test(line)) {
        quotedBlock = true;
      }
    }
    if (lineEnd >= offset) {
      break;
    }
    lineStart = lineEnd + 1;
  }
  return { insideFence: open !== null, inlineStart, quotedBlock };
}

/**
 * Refused positions are exactly the five published classes. An indented code
 * block and an HTML comment are deliberately not classified: a four-space
 * indent is also ordinary list-continuation content, so refusing it would block
 * valid records more often than it would catch example text.
 */
export function classifyPosition(body: string, offset: number): CitationRejectionClass | null {
  const block = blockPosition(body, offset);
  if (block.insideFence) return "code-fence";
  const { start, end } = lineBounds(body, offset);
  const line = body.slice(start, end);
  if (BLOCKQUOTE_RE.test(line) || block.quotedBlock) return "blockquote";
  const preceding = body.slice(block.inlineStart, offset);
  if (isInsideInlineCode(preceding)) return "inline-code";
  if (isStruckThrough(preceding)) return "strikethrough";
  if (isNegated(line, offset - start)) return "negation";
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
