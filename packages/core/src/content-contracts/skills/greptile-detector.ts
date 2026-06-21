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

  let tier3_sentinel = false;
  if (body.includes("Not safe to merge")) {
    tier3_sentinel = true;
  }
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

export function evaluateCleanGate(params: {
  lastReviewedSha: string | null;
  headSha: string;
  hasBlocking: boolean;
  confidence: number | null;
  ciFailures: number;
  errored: boolean;
  terminalCheckRun?: boolean;
}): [boolean, string | null] {
  const {
    lastReviewedSha,
    headSha,
    hasBlocking,
    confidence,
    ciFailures,
    errored,
    terminalCheckRun = true,
  } = params;

  if (lastReviewedSha === null || lastReviewedSha !== headSha) {
    return [false, "sha_match"];
  }
  if (hasBlocking) {
    return [false, "has_blocking"];
  }
  if (confidence === null || confidence <= 3) {
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
