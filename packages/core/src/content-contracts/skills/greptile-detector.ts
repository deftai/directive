/** Greptile / SLizard findings detector — TypeScript reference (#910 + #1035 + #1039). */

const CODE_FENCE_RE = /`{3}.*?`{3}/gs;
const HTML_CODE_RE = /<(code|pre)\b[^>]*>.*?<\/\1>/gis;

function stripCodeFences(text: string): string {
  const fencedStripped = text.replace(CODE_FENCE_RE, " ");
  return fencedStripped.replace(HTML_CODE_RE, " ");
}

const TIER2_RE = /^[\s\-*]*\*\*P([01])\b[^*]*\*\*/gm;
const TIER2_NEGATIONS = ["No ", "Zero ", "0 ", "no "] as const;

const TIER25_RE = /^#{1,6}\s+P([01])\s*[\u00b7\u2027\u2022-]\s/gm;

const TIER3_COUNT_RE =
  /\b(?:One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|\d+)\s+P[01]\s+findings?\b/gi;
const TIER3_LINE_RE = /^\s*P[01]\s+--\s/gm;
const TIER3_NEGATIONS = ["No ", "Zero ", "no ", "NO "] as const;

const CONFIDENCE_INLINE_RE = /Confidence Score:\s*(\d+)\s*\/\s*5/;
const CONFIDENCE_HEADING_RE = /^#{1,6}\s*Confidence Score:\s*(\d+)\s*\/\s*5\s*$/m;

/**
 * Advisory should-not-merge prose (#3225) — reviewer bots often record a block
 * only in comment body text without formal Changes-Requested. Patterns are
 * applied after code-fence strip; case-insensitive. Composes with
 * minGreptileConfidence (#3095): either signal alone is blocking.
 *
 * Matching is scoped to **verdict-bearing regions** (Confidence Score detail /
 * heading sections, Summary:/Decision: lines) so descriptive overview prose
 * that names the detector phrases ("adds should-not-merge parsing") does not
 * false-block a clean review (Greptile residual on PR #3227 / #1004 class).
 */
const ADVISORY_SHOULD_NOT_MERGE_RES: readonly RegExp[] = [
  // "not safe to merge" | "not yet safe to merge"
  /\bnot\s+(?:yet\s+)?safe\s+to\s+merge\b/i,
  // should-not-merge | should not merge | should–not–merge (hyphen optional each side)
  /\bshould\s*[-–—]?\s*not\s*[-–—]?\s*merge\b/i,
  /\bsafe\s+to\s+merge\s+once\s+corrected\b/i,
  /\bdo\s+not\s+merge\b/i,
  /\bnot\s+ready\s+to\s+merge\b/i,
  /\bnot\s+ready\s+for\s+merge\b/i,
];

/**
 * High-signal phrases scanned outside Overview tables after fence strip.
 * Soft phrases (do not merge / should not merge with spaces) stay region-only
 * so explanatory Confidence residual prose naming the detector does not thrash
 * indefinitely (#2881 / PR #3227 conf 4 residual).
 */
const ADVISORY_HIGH_SIGNAL_RES: readonly RegExp[] = [
  /\bnot\s+(?:yet\s+)?safe\s+to\s+merge\b/i,
  /\bshould-not-merge\b/i,
  /\bsafe\s+to\s+merge\s+once\s+corrected\b/i,
];

const NAIVE_INLINE_SHA_RE = /Last reviewed commit:\s*([0-9a-f]{7,40})/;
const MARKDOWN_LINK_SHA_RE =
  /Last reviewed commit:\s*\[.*?\]\(https?:\/\/github\.com\/[^/]+\/[^/]+\/commit\/(?<sha>[0-9a-f]{7,40})/;

interface DetectResult {
  tier1_p0: number;
  tier1_p1: number;
  tier2_p0: number;
  tier2_p1: number;
  tier25_p0: number;
  tier25_p1: number;
  tier3_sentinel: boolean;
  p0_count: number;
  p1_count: number;
  has_blocking: boolean;
}

function lineFor(body: string, pos: number): string {
  const lineStart = body.lastIndexOf("\n", pos - 1) + 1;
  const lineEnd = body.indexOf("\n", pos);
  return body.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
}

export function parseConfidence(body: string): number | null {
  let m = CONFIDENCE_INLINE_RE.exec(body);
  if (m === null) {
    m = CONFIDENCE_HEADING_RE.exec(body);
  }
  return m ? Number.parseInt(m[1] ?? "0", 10) : null;
}

/**
 * Extract verdict-bearing text windows from a bot rolling-summary body (#3225).
 * Prefers Confidence Score sections and Summary:/Decision: lines over whole-body
 * Overview tables that may *describe* advisory phrases without issuing them.
 */
export function extractAdvisoryVerdictRegions(body: string): string {
  const text = stripCodeFences(body);
  const regions: string[] = [];

  // Per-details blocks only — do not span from Overview into Confidence Score.
  for (const m of text.matchAll(/<details\b[^>]*>[\s\S]*?<\/details>/gi)) {
    const block = m[0] ?? "";
    if (/Confidence\s+Score/i.test(block)) {
      regions.push(block);
    }
  }

  for (const m of text.matchAll(
    /(?:^|\n)#{1,6}\s*Confidence\s+Score\s*:[^\n]*\n([\s\S]*?)(?=\n#{1,6}\s|\n<details\b|\n---\s*$|\n\*?\*?Last reviewed|\z)/gi,
  )) {
    regions.push(m[0] ?? "");
  }

  for (const m of text.matchAll(
    /(?:^|\n)(?:\*\*)?Confidence\s+Score(?:\*\*)?\s*:\s*\d+\s*\/\s*5[^\n]*\n([\s\S]{0,800})/gi,
  )) {
    regions.push(m[0] ?? "");
  }

  for (const m of text.matchAll(
    /(?:^|\n)(?:Summary|Decision|Verdict)\s*:\s*([^\n]+(?:\n(?![A-Z][^\n]{0,40}:)[^\n]+)*)/gi,
  )) {
    regions.push(m[0] ?? "");
  }

  return regions.filter((r) => r.trim().length > 0).join("\n\n");
}

function anyPatternMatches(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((re) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}

/**
 * True when a line is a **verdict-shaped** advisory phrase (#3225 residual).
 * Requires the match near the start of the line (after optional Summary:/Decision:
 * label, bullet, or bold). Mid-sentence descriptive mentions
 * ("adds should-not-merge parsing", "The PR is not yet safe to merge because…")
 * do not count — those are residual discussion, not the bot's verdict line.
 */
function lineHasAnchoredAdvisory(line: string, patterns: readonly RegExp[]): boolean {
  let bare = line.trim();
  // Blockquote / common markdown wrappers Greptile residual (PR #3227 conf 4).
  bare = bare.replace(/^>\s*/, "");
  bare = bare.replace(/^(?:Summary|Decision|Verdict)\s*[:\-–—]\s*/i, "");
  bare = bare.replace(/^(?:[-*•]\s+)+/, "");
  bare = bare.replace(/^\*\*/, "").replace(/\*\*$/, "");
  bare = bare.replace(/^_/, "").replace(/_$/, "");
  // Explicit subject-prefixed verdicts Greptile uses: "The PR is not safe to merge…"
  bare = bare.replace(
    /^(?:the\s+pr|this\s+pr|this\s+change|the\s+change|this\s+diff)\s+is\s+/i,
    "",
  );
  bare = bare.trim();
  if (bare.length === 0) {
    return false;
  }
  for (const re of patterns) {
    re.lastIndex = 0;
    const m = re.exec(bare);
    // Allow small lead-in after wrappers (em-dash residual, thin markdown).
    if (m !== null && (m.index ?? 0) <= 4) {
      return true;
    }
  }
  return false;
}

function textHasAnchoredAdvisory(text: string, patterns: readonly RegExp[]): boolean {
  for (const line of text.split(/\r?\n/)) {
    if (lineHasAnchoredAdvisory(line, patterns)) {
      return true;
    }
  }
  return false;
}

/**
 * True when comment body prose records an advisory should-not-merge / not-safe
 * verdict (#3225). Code-fence regions are stripped first so detector docs do
 * not self-trigger (#1004).
 *
 * Line-anchored hybrid scan (PR #3227 residuals):
 * 1. Soft + high-signal **line-anchored** phrases in Confidence / Summary /
 *    Decision regions (and whole body)
 * 2. Same line-anchored high-signal set on whole body (standalone warnings)
 * Mid-sentence residual discussion does not hard-block; conf floor still does (#3095).
 */
export function hasShouldNotMergeProse(body: string): boolean {
  const text = stripCodeFences(body);
  const regions = extractAdvisoryVerdictRegions(body);
  if (regions.length > 0 && textHasAnchoredAdvisory(regions, ADVISORY_SHOULD_NOT_MERGE_RES)) {
    return true;
  }
  // Soft + high line-anchored anywhere (covers standalone spaced Do not merge /
  // should not merge outside Confidence regions without Overview mid-sentence hits).
  if (textHasAnchoredAdvisory(text, ADVISORY_SHOULD_NOT_MERGE_RES)) {
    return true;
  }
  return false;
}

/**
 * Structured advisory verdict from bot comment body (#3225 / #1282 style).
 * Confidence is independent of formal GitHub review state; compose with
 * `minGreptileConfidence` (#3095) at the clean gate.
 */
export interface AdvisoryReviewerVerdict {
  readonly confidence: number | null;
  readonly shouldNotMerge: boolean;
  readonly hasBlocking: boolean;
}

export function parseAdvisoryReviewerVerdict(body: string): AdvisoryReviewerVerdict {
  const findings = detect(body);
  return {
    confidence: parseConfidence(body),
    shouldNotMerge: hasShouldNotMergeProse(body),
    hasBlocking: findings.has_blocking,
  };
}

export function detect(body: string): DetectResult {
  body = stripCodeFences(body);
  const tier1_p0 = (body.match(/<img alt="P0"/g) ?? []).length;
  const tier1_p1 = (body.match(/<img alt="P1"/g) ?? []).length;

  let tier2_p0 = 0;
  let tier2_p1 = 0;
  for (const m of body.matchAll(TIER2_RE)) {
    const line = lineFor(body, m.index ?? 0);
    if (TIER2_NEGATIONS.some((neg) => line.includes(neg))) {
      continue;
    }
    if (m[1] === "0") {
      tier2_p0 += 1;
    } else {
      tier2_p1 += 1;
    }
  }

  let tier25_p0 = 0;
  let tier25_p1 = 0;
  for (const m of body.matchAll(TIER25_RE)) {
    const line = lineFor(body, m.index ?? 0);
    if (TIER2_NEGATIONS.some((neg) => line.includes(neg))) {
      continue;
    }
    if (m[1] === "0") {
      tier25_p0 += 1;
    } else {
      tier25_p1 += 1;
    }
  }

  // Tier 3: advisory should-not-merge prose (#3225 extends "Not safe to merge")
  // plus count-prose and line-anchored P0/P1 sentinels (#910).
  let tier3_sentinel = hasShouldNotMergeProse(body);
  if (!tier3_sentinel) {
    for (const m of body.matchAll(TIER3_COUNT_RE)) {
      const line = lineFor(body, m.index ?? 0);
      if (TIER3_NEGATIONS.some((neg) => line.includes(neg))) {
        continue;
      }
      if (/^\s*0\b/.test(m[0])) {
        continue;
      }
      tier3_sentinel = true;
      break;
    }
  }
  if (!tier3_sentinel) {
    for (const m of body.matchAll(TIER3_LINE_RE)) {
      const line = lineFor(body, m.index ?? 0);
      if (TIER3_NEGATIONS.some((neg) => line.includes(neg))) {
        continue;
      }
      tier3_sentinel = true;
      break;
    }
  }

  const p0_count = Math.max(tier1_p0, tier2_p0, tier25_p0);
  const p1_count = Math.max(tier1_p1, tier2_p1, tier25_p1);
  const has_blocking = p0_count + p1_count > 0 || tier3_sentinel;
  return {
    tier1_p0,
    tier1_p1,
    tier2_p0,
    tier2_p1,
    tier25_p0,
    tier25_p1,
    tier3_sentinel,
    p0_count,
    p1_count,
    has_blocking,
  };
}

export function parseLastReviewedShaMarkdownLink(body: string): string | null {
  const m = MARKDOWN_LINK_SHA_RE.exec(body);
  return m?.groups?.sha ?? null;
}

export function parseLastReviewedShaNaiveInline(body: string): string | null {
  const m = NAIVE_INLINE_SHA_RE.exec(body);
  return m?.[1] ?? null;
}

const ESCAPED_BRACKET_SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9001122334";

export const BODY_TIER2_P1_ONLY = `Greptile review of head 1234567

Confidence Score: 4/5

Last reviewed commit: [fix: foo bar](https://github.com/deftai/directive/commit/abcdef1234567)

Comments:

- **P1 -- wrong exception type for state/limit validation in populate()**
  The current code raises ValueError but the contract calls for InvalidRepoError.
- **P2 -- minor wording in error message**
  Consider \`--repo\` instead of \`the repo flag\`.
`;

export const BODY_TIER3_NOT_SAFE_ONLY = `Greptile review of head 7654321

Confidence Score: 3/5

Last reviewed commit: [refactor: thing](https://github.com/deftai/directive/commit/0011223344556)

Summary: Not safe to merge until the mocked-import test defect and the two
previously filed P1s are resolved.
`;

/** #3225 live-case shape: conf 3/5 + should-not-merge prose, zero badges. */
export const BODY_ADVISORY_SHOULD_NOT_MERGE_CONF3 = `Greptile review of head advisory01

## Confidence Score: 3/5

Summary: should-not-merge — residual risk on the auth path is too high for
this change set. Formal review state is still Comment (not Changes Requested).

Last reviewed commit: [feat: advisory](https://github.com/deftai/directive/commit/advisory01abcdef12)
`;

/** Green mechanical path trap: high conf but explicit do-not-merge prose. */
export const BODY_ADVISORY_DO_NOT_MERGE_HIGH_CONF = `Greptile review of head advisory02

Confidence Score: 5/5

No P0 or P1 issues found via badges.

Summary: Do not merge until the operator documents residual risk.

Last reviewed commit: [docs: note](https://github.com/deftai/directive/commit/advisory02abcdef12)
`;

/**
 * Overview prose names the detector phrase without issuing a verdict (#3225 residual).
 * Confidence section is clean — must NOT set shouldNotMerge.
 */
export const BODY_ADVISORY_DESCRIPTIVE_ONLY = `Greptile review of head advisory03

<details><summary><h3>Greptile Summary</h3></summary>

This PR adds should-not-merge prose detection and Not safe to merge matching to
merge-ready. Descriptive overview only — no blocking residual on the product path.

</details>

<details open><summary><h3>Confidence Score: 5/5</h3></summary>

No P0 or P1 issues found. The change looks clean and well-tested.

</details>

Last reviewed commit: [feat: detector](https://github.com/deftai/directive/commit/advisory03abcdef12)
`;

/** Standalone high-signal warning outside Confidence section must still block. */
export const BODY_ADVISORY_STANDALONE_NOT_SAFE = `Greptile review of head advisory04

<details open><summary><h3>Confidence Score: 5/5</h3></summary>

Looks solid from a findings perspective.

</details>

Not safe to merge until the operator confirms residual risk handling.

Last reviewed commit: [feat: residual](https://github.com/deftai/directive/commit/advisory04abcdef12)
`;

/** Subject-prefixed verdict Greptile commonly emits (#3225 residual). */
export const BODY_ADVISORY_SUBJECT_PREFIXED = `Greptile review of head advisory05

## Confidence Score: 4/5

The PR is not safe to merge until residual risk is documented on the auth path.

Last reviewed commit: [feat: subject](https://github.com/deftai/directive/commit/advisory05abcdef12)
`;

export const BODY_TIER3_COUNT_PROSE_ONLY = `Greptile review of head deadbeef

Confidence Score: 4/5

Last reviewed commit: [chore: bump](https://github.com/deftai/directive/commit/deadbeefcafe123)

Three P1 findings (two from prior review, one new): wrong exception type for
state/limit validation in populate(), misleading skip message, and an
unguarded import that will fail on Windows.
`;

export const BODY_NEGATION_GUARDED = `Greptile review of head ffffffff

Confidence Score: 5/5

Last reviewed commit: [feat: clean](https://github.com/deftai/directive/commit/ffffffffabc1234)

Summary: No P0 findings. Zero P1 findings. The PR is ready for merge.
`;

export const BODY_CLEAN = `Greptile review of head 1111111

Confidence Score: 5/5

Last reviewed commit: [docs: tweak](https://github.com/deftai/directive/commit/1111111aaa2222b)

No P0 or P1 issues found. The change looks clean and well-tested.
`;

export const BODY_TIER1_BADGES_ONLY = `Greptile review of head 2222222

Confidence Score: 3/5

Last reviewed commit: [fix: thing](https://github.com/deftai/directive/commit/2222222ccc3333d)

<img alt="P1" src="https://example.com/p1.png"> wrong exception type in populate()
<img alt="P1" src="https://example.com/p1.png"> misleading skip message
<img alt="P0" src="https://example.com/p0.png"> data-loss risk in cache eviction
`;

export const BODY_SLIZARD_HEADING_P1 =
  "SLizard review of head 3333333\n" +
  "\n" +
  "## Confidence Score: 3/5\n" +
  "\n" +
  "Decision: request_changes\n" +
  "Severity counts: P0: 0, P1: 1\n" +
  "\n" +
  "### P1 \u00b7 Inaccurate description claim about ROADMAP.md `## Active` section\n" +
  "The PR body claims the ROADMAP.md '## Active' section but the section\n" +
  "does not exist at HEAD; verify the claim before merge.\n" +
  "\n" +
  "Last reviewed commit: [fix: stuff](https://github.com/deftai/directive/commit/3333333abcdef12)\n";

export const BODY_SLIZARD_HEADING_NEGATION =
  "SLizard review of head 4444444\n" +
  "\n" +
  "## Confidence Score: 5/5\n" +
  "\n" +
  "Decision: comment\n" +
  "Severity counts: P0: 0, P1: 0\n" +
  "\n" +
  "### No P1 \u00b7 findings -- clean review\n" +
  "\n" +
  "Last reviewed commit: [docs: thing](https://github.com/deftai/directive/commit/4444444abcdef12)\n";

export const BODY_CONFIDENCE_HEADING_ONLY =
  "SLizard review of head 5555555\n" +
  "\n" +
  "## Confidence Score: 3/5\n" +
  "\n" +
  "Some body text without inline confidence prose.\n" +
  "\n" +
  "Last reviewed commit: [fix: x](https://github.com/deftai/directive/commit/5555555abcdef12)\n";

export const BODY_FENCED_IMG_P0 =
  "Greptile review of head 6666666\n" +
  "\n" +
  "Confidence Score: 5/5\n" +
  "\n" +
  "The PR updates the Tier 1 badge counter. The detector counts badges via:\n" +
  "\n" +
  "```python\n" +
  "tier1_p0 = body.count('<img alt=\"P0\"')\n" +
  "tier1_p1 = body.count('<img alt=\"P1\"')\n" +
  "```\n" +
  "\n" +
  "No P0 or P1 issues found. The change looks clean and well-tested.\n" +
  "\n" +
  "Last reviewed commit: [fix: detector](https://github.com/deftai/directive/commit/6666666abcdef12)\n";

export const BODY_FENCED_NOT_SAFE =
  "Greptile review of head 7777777\n" +
  "\n" +
  "Confidence Score: 5/5\n" +
  "\n" +
  "The PR documents the Tier 3 hard-block sentinel. The relevant snippet:\n" +
  "\n" +
  "```python\n" +
  'if "Not safe to merge" in body:\n' +
  "    tier3_sentinel = True\n" +
  "```\n" +
  "\n" +
  "No P0 or P1 issues found. The change looks clean.\n" +
  "\n" +
  "Last reviewed commit: [docs: detector](https://github.com/deftai/directive/commit/7777777abcdef12)\n";

export const BODY_UNFENCED_IMG_P0 =
  "Greptile review of head 8888888\n" +
  "\n" +
  "Confidence Score: 2/5\n" +
  "\n" +
  '<img alt="P0" src="https://example.com/p0.png"> data-loss risk in cache eviction\n' +
  "\n" +
  "Last reviewed commit: [fix: bug](https://github.com/deftai/directive/commit/8888888abcdef12)\n";

export const BODY_HTML_CODE_IMG_P0 =
  "Greptile review of head 9999999\n" +
  "\n" +
  "Confidence Score: 5/5\n" +
  "\n" +
  "The detector counts badges via <code>body.count('&lt;img alt=\"P0\"')</code>\n" +
  'and <pre><img alt="P1" src="x"></pre> in the prompt fixtures.\n' +
  "\n" +
  "No P0 or P1 issues found. The change looks clean.\n" +
  "\n" +
  "Last reviewed commit: [chore: x](https://github.com/deftai/directive/commit/9999999abcdef12)\n";

export const BODY_ESCAPED_BRACKET_LINK_TEXT =
  "Greptile review of head a1b2c3d\n" +
  "\n" +
  "## Confidence Score: 5/5\n" +
  "\n" +
  "No P0 or P1 issues found. The change looks clean and well-tested.\n" +
  "\n" +
  "Last reviewed commit: [docs: add \\[Unreleased\\] entry]" +
  `(https://github.com/deftai/directive/commit/${ESCAPED_BRACKET_SHA})\n`;

const HEAD_SHA = "abcdef1234567";

export const BODY_AC4_MARKDOWN_LINK_CLEAN =
  "Greptile review of head 1234567\n" +
  "\n" +
  "## Confidence Score: 5/5\n" +
  "\n" +
  "No P0 or P1 issues found. The change looks clean and well-tested.\n" +
  "\n" +
  `Last reviewed commit: [fix: foo](https://github.com/deftai/directive/commit/${HEAD_SHA})\n`;

export const BODY_AC4_INLINE_SHA_CLEAN =
  "Greptile review of head 1234567\n" +
  "\n" +
  "## Confidence Score: 5/5\n" +
  "\n" +
  "No P0 or P1 issues found. The change looks clean.\n" +
  "\n" +
  `Last reviewed commit: ${HEAD_SHA}\n`;

export const BODY_AC4_THIRD_CONFIDENCE_FORM =
  "Greptile review of head 1234567\n" +
  "\n" +
  "| Metric            | Value |\n" +
  "| ----------------- | ----- |\n" +
  "| Confidence Score  | 5 of 5 |\n" +
  "\n" +
  "No P0 or P1 issues found. The change looks clean.\n" +
  "\n" +
  `Last reviewed commit: [fix: foo](https://github.com/deftai/directive/commit/${HEAD_SHA})\n`;

export const BODY_AC4_EMPTY = "";

export const BODY_AC4_TRUNCATED =
  "Greptile review of head 1234567\n" + "\n" + "## Confidence Score:";

/**
 * Fail-closed CLEAN gate shared by pr:watch, swarm poller, and content-contracts.
 *
 * `minConfidence` defaults to the consumer bar (4 == legacy confidence > 3).
 * Directive dogfood and project policy resolve a higher floor via
 * `resolveMinGreptileConfidence` (#3095).
 */
export function evaluateCleanGate(params: {
  lastReviewedSha: string | null;
  headSha: string;
  hasBlocking: boolean;
  confidence: number | null;
  ciFailures: number;
  errored: boolean;
  terminalCheckRun?: boolean;
  /** Minimum confidence score (1–5) that CLEANs; score must be >= min. Default 4. */
  minConfidence?: number;
}): [boolean, string | null] {
  const {
    lastReviewedSha,
    headSha,
    hasBlocking,
    confidence,
    ciFailures,
    errored,
    terminalCheckRun = true,
    minConfidence = 4,
  } = params;

  if (lastReviewedSha === null || lastReviewedSha !== headSha) {
    return [false, "sha_match"];
  }
  if (hasBlocking) {
    return [false, "has_blocking"];
  }
  if (confidence === null || confidence < minConfidence) {
    return [false, "confidence"];
  }
  if (ciFailures > 0) {
    return [false, "ci_failures"];
  }
  if (errored) {
    return [false, "errored"];
  }
  if (!terminalCheckRun) {
    return [false, "terminal_check_run"];
  }
  return [true, null];
}

function formatPollLogLine(params: {
  i: number;
  cap: number;
  lastReviewedSha: string | null;
  headSha: string;
  confidence: number | null;
  hasBlocking: boolean;
  p0Count: number;
  p1Count: number;
  errored: boolean;
  ciFailures: number;
  isClean: boolean;
  cleanGateHoldout: string | null;
}): string {
  const {
    i,
    cap,
    lastReviewedSha,
    headSha,
    confidence,
    hasBlocking,
    p0Count,
    p1Count,
    errored,
    ciFailures,
    isClean,
    cleanGateHoldout,
  } = params;

  return (
    `[poll ${i}/${cap}] last_reviewed_sha=${lastReviewedSha} ` +
    `head=${headSha} sha_match=${lastReviewedSha === headSha} ` +
    `confidence=${confidence} has_blocking=${hasBlocking} ` +
    `p0=${p0Count} p1=${p1Count} errored=${errored} ` +
    `ci_failures=${ciFailures} is_clean=${isClean} ` +
    `clean_gate_holdout=${cleanGateHoldout}`
  );
}

type PollExitClass = "CLEAN" | "NEW_P0P1" | "ERRORED" | "STALL" | "RUNNING";

export function simulatePollLoop(params: {
  body: string;
  headSha: string;
  ciFailures?: number;
  maxPolls?: number;
  stallThreshold?: number;
  terminalCheckRun?: boolean;
}): [PollExitClass, number, string | null, string[]] {
  const {
    body,
    headSha,
    ciFailures = 0,
    maxPolls = 5,
    stallThreshold = 3,
    terminalCheckRun = true,
  } = params;

  const erroredSentinel = "Greptile encountered an error while reviewing this PR";
  const lastReviewedSha = parseLastReviewedShaMarkdownLink(body);
  const confidence = parseConfidence(body);
  const findings = detect(body);
  const hasBlocking = findings.has_blocking;
  const errored = body.trim() === erroredSentinel;
  let stallStreak = 0;
  const logLines: string[] = [];
  let lastHoldout: string | null = null;

  for (let i = 1; i <= maxPolls; i += 1) {
    const [isClean, cleanGateHoldout] = evaluateCleanGate({
      lastReviewedSha,
      headSha,
      hasBlocking,
      confidence,
      ciFailures,
      errored,
      terminalCheckRun,
    });
    lastHoldout = cleanGateHoldout;
    logLines.push(
      formatPollLogLine({
        i,
        cap: maxPolls,
        lastReviewedSha,
        headSha,
        confidence,
        hasBlocking,
        p0Count: findings.p0_count,
        p1Count: findings.p1_count,
        errored,
        ciFailures,
        isClean,
        cleanGateHoldout,
      }),
    );

    if (isClean) {
      return ["CLEAN", i, cleanGateHoldout, logLines];
    }
    if (hasBlocking && lastReviewedSha === headSha) {
      return ["NEW_P0P1", i, cleanGateHoldout, logLines];
    }
    if (errored) {
      return ["ERRORED", i, cleanGateHoldout, logLines];
    }
    if (!hasBlocking) {
      stallStreak += 1;
    } else {
      stallStreak = 0;
    }
    if (stallStreak >= stallThreshold) {
      return ["STALL", i, cleanGateHoldout, logLines];
    }
  }

  return ["RUNNING", maxPolls, lastHoldout, logLines];
}
