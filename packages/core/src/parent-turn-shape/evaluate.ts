/**
 * Parent turn-shape hard-stop for text-repetition hang (FC14 / #3131).
 *
 * Soft skill prose (#2943) alone is insufficient: parents still burn the full
 * output budget on identical progress sentences with zero tool_use after leaf
 * announce. This pure library is the Directive-side machine-checkable gate.
 *
 * Hosts (OpenClaw, swarm parents, review monitors) SHOULD evaluate the parent
 * turn stream mid-generation and hard-stop when `ok` is false.
 *
 * Illegal shape (MUST NOT):
 *   N > maxIdenticalWithoutTool (default 2) near-identical assistant sentences
 *   (or streaming text chunks) in one turn with no tool_use and no yield.
 *
 * Legal post-announce shapes:
 *   1. Tool batch (ground-truth) then one consolidate
 *   2. sessions_yield / wait without filler
 *   3. One short user answer that is NOT a repeated progress line
 */

/** Failure class codes for operator / host recovery surfaces. */
export type ParentTurnFailClass =
  | "none"
  | "FC14"
  | "text-repetition-hang"
  | "progress-only-no-tool";

/** Ordered events observed within a single parent turn. */
export type ParentTurnEvent =
  | { kind: "assistant_text"; text: string }
  | { kind: "tool_use"; name?: string }
  | { kind: "yield" };

export interface ParentTurnShapeInput {
  /** Ordered events from one parent turn (streaming deltas may be separate). */
  readonly events: readonly ParentTurnEvent[];
  /**
   * When true, multi-sentence progress-only text with zero tools/yield is also
   * illegal even without exact N>2 identity (post-`subagent_announce` policy).
   */
  readonly afterSubagentAnnounce?: boolean;
  /**
   * Max near-identical consecutive (or within-turn) text units allowed without
   * tool_use / yield. Issue contract: MUST NOT emit N>2 → default max = 2.
   */
  readonly maxIdenticalWithoutTool?: number;
}

export interface ParentTurnShapeResult {
  readonly ok: boolean;
  /** Primary fail class (`FC14` aliases `text-repetition-hang`). */
  readonly failClass: ParentTurnFailClass;
  readonly reasons: readonly string[];
  /** Highest count of near-identical text units observed without tool/yield. */
  readonly maxIdenticalCount: number;
  readonly hasToolUse: boolean;
  readonly hasYield: boolean;
}

/** Canonical fail class for the hang (#3131 / soft FC14 recurrence of #2943). */
export const PARENT_TURN_FAIL_FC14 = "FC14" as const;

/** Default max identical text units without tool/yield (N>2 is illegal). */
export const DEFAULT_MAX_IDENTICAL_WITHOUT_TOOL = 2;

/** Minimum length (chars) for a text unit to count toward repetition. */
const MIN_UNIT_LEN = 12;

/** Word Jaccard threshold for near-identical (after normalize). */
const JACCARD_NEAR = 0.9;

/** Progress-ish tokens that mark filler narration after announce. */
const PROGRESS_HINT_RE =
  /\b(checking|checking\s+worktrees|open\s+prs?|next|unfinished|implementing|looking\s+at|will\s+(check|inspect|verify|spawn)|status\s+next|monitor(?:ing)?)\b/i;

/**
 * Normalize assistant text for identity comparison.
 * Collapses whitespace, lowercases, strips common trailing punctuation.
 */
export function normalizeTurnText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s"'`]+|[\s"'`]+$/g, "")
    .replace(/[.!?…,:;]+$/g, "")
    .trim();
}

/** Split a blob into sentence-like units (periods, newlines, ellipsis). */
export function splitTextUnits(text: string): string[] {
  const raw = text.replace(/\r\n/g, "\n");
  // Include single newlines so block-formatted repeated progress lines still
  // unitize (FC14 hang class often streams one line per newline, no period).
  const parts = raw
    .split(/(?:\n+|(?<=[.!?…])\s+|(?<=\.\.\.)\s+)/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0 && raw.trim().length > 0) {
    return [raw.trim()];
  }
  return parts;
}

function wordSet(normalized: string): Set<string> {
  const words = normalized.split(/[^a-z0-9_]+/).filter((w) => w.length > 0);
  return new Set(words);
}

/**
 * True when two normalized strings are near-identical (exact, containment with
 * high length ratio, or high word Jaccard). Short units never match.
 */
export function isNearIdentical(a: string, b: string): boolean {
  const na = normalizeTurnText(a);
  const nb = normalizeTurnText(b);
  if (na.length < MIN_UNIT_LEN || nb.length < MIN_UNIT_LEN) return false;
  if (na === nb) return true;

  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  if (longer.includes(shorter) && shorter.length / longer.length >= 0.85) {
    return true;
  }

  const sa = wordSet(na);
  const sb = wordSet(nb);
  if (sa.size === 0 || sb.size === 0) return false;
  let inter = 0;
  for (const w of sa) {
    if (sb.has(w)) inter += 1;
  }
  const union = sa.size + sb.size - inter;
  if (union === 0) return false;
  return inter / union >= JACCARD_NEAR;
}

/**
 * Collect assistant text units from turn events.
 *
 * Streaming hosts often emit word/chunk deltas as separate `assistant_text`
 * events. Coalesce consecutive text events into one blob so fragmented
 * progress sentences reconstruct before split/identity checks (P1 / #3131).
 * Non-text events (tool_use / yield) flush the coalesce buffer.
 */
function collectAssistantUnits(events: readonly ParentTurnEvent[]): string[] {
  const units: string[] = [];
  const pushUnitsFrom = (text: string): void => {
    for (const u of splitTextUnits(text)) {
      const t = u.trim();
      if (t.length >= MIN_UNIT_LEN) units.push(t);
    }
  };

  let run = "";
  for (const ev of events) {
    if (ev.kind === "assistant_text") {
      const text = typeof ev.text === "string" ? ev.text : "";
      if (!text) continue;
      // Whole-sentence deltas often arrive without a trailing space before the
      // next identical sentence. Insert a boundary so splitTextUnits can cut.
      if (run.length > 0 && /[.!?…]["']?\s*$/.test(run) && !/^\s/.test(text)) {
        run += " ";
      }
      run += text;
      continue;
    }
    // Non-text event ends the coalesce run (tool/yield boundaries).
    if (run.trim().length > 0) pushUnitsFrom(run);
    run = "";
  }
  if (run.trim().length > 0) pushUnitsFrom(run);
  return units;
}

/**
 * Max count of any single near-identical cluster among units.
 * Consecutive runs + exact-normalized frequency (O(n)); for small unit counts
 * also pairwise near-identical frequency so non-consecutive punctuation variants
 * cannot bypass FC14 (P1 / #3131).
 */
function maxIdenticalCluster(units: readonly string[]): number {
  if (units.length === 0) return 0;

  const norms = units.map((u) => normalizeTurnText(u));
  let maxRun = 1;
  let run = 1;
  for (let i = 1; i < units.length; i++) {
    if (isNearIdentical(units[i] ?? "", units[i - 1] ?? "")) {
      run += 1;
      if (run > maxRun) maxRun = run;
    } else {
      run = 1;
    }
  }

  // Frequency by exact normalized form (O(n)).
  const freq = new Map<string, number>();
  let maxFreq = 1;
  for (const n of norms) {
    if (n.length < MIN_UNIT_LEN) continue;
    const next = (freq.get(n) ?? 0) + 1;
    freq.set(n, next);
    if (next > maxFreq) maxFreq = next;
  }

  // Pairwise near-identical for non-consecutive variants (punctuation / wording).
  // Parent-turn unit counts stay small; cap pairwise work for pathological blobs.
  const PAIRWISE_CAP = 64;
  if (units.length <= PAIRWISE_CAP) {
    for (let i = 0; i < units.length; i++) {
      let near = 1;
      for (let j = i + 1; j < units.length; j++) {
        if (isNearIdentical(units[i] ?? "", units[j] ?? "")) near += 1;
      }
      if (near > maxFreq) maxFreq = near;
    }
  }

  return Math.max(maxRun, maxFreq);
}

/**
 * Detect when a single blob itself embeds the same sentence many times
 * (model streams one giant assistant message of repeated lines).
 */
export function countRepeatedUnitsInBlob(text: string): number {
  const units = splitTextUnits(text).filter((u) => u.trim().length >= MIN_UNIT_LEN);
  return maxIdenticalCluster(units);
}

function looksLikeProgressOnly(units: readonly string[]): boolean {
  if (units.length < 2) return false;
  let progressHits = 0;
  for (const u of units) {
    if (PROGRESS_HINT_RE.test(u)) progressHits += 1;
  }
  // Majority of multi-sentence text is progress narration.
  return progressHits >= Math.ceil(units.length / 2);
}

/**
 * Evaluate whether a parent turn shape is legal under the FC14 hard-stop.
 * Pure / side-effect free — safe for mid-stream host gates and unit tests.
 */
export function evaluateParentTurnShape(input: ParentTurnShapeInput): ParentTurnShapeResult {
  const events = input.events ?? [];
  const maxAllowed = input.maxIdenticalWithoutTool ?? DEFAULT_MAX_IDENTICAL_WITHOUT_TOOL;

  let hasToolUse = false;
  let hasYield = false;
  for (const ev of events) {
    if (ev.kind === "tool_use") hasToolUse = true;
    if (ev.kind === "yield") hasYield = true;
  }

  // Tool or yield greases the turn: repetition hard-stop does not fire.
  if (hasToolUse || hasYield) {
    return {
      ok: true,
      failClass: "none",
      reasons: [],
      maxIdenticalCount: 0,
      hasToolUse,
      hasYield,
    };
  }

  const units = collectAssistantUnits(events);
  // Also fold in whole-blob repetition for single giant text events.
  let maxIdenticalCount = maxIdenticalCluster(units);
  for (const ev of events) {
    if (ev.kind === "assistant_text" && typeof ev.text === "string") {
      maxIdenticalCount = Math.max(maxIdenticalCount, countRepeatedUnitsInBlob(ev.text));
    }
  }

  const reasons: string[] = [];
  let failClass: ParentTurnFailClass = "none";

  if (maxIdenticalCount > maxAllowed) {
    failClass = "FC14";
    reasons.push(
      `FC14 text-repetition-hang: ${maxIdenticalCount} near-identical assistant text units ` +
        `with zero tool_use/yield (max allowed ${maxAllowed}; N>${maxAllowed} is illegal). ` +
        `After subagent announce, emit a tool-first ground-truth batch, sessions_yield, ` +
        `or one short non-repeated answer — not repeated progress lines. Refs #3131 / #2943.`,
    );
  }

  // Post-announce: multi-sentence progress-only with zero tools is also illegal
  // even when sentences are not exact clones (soft-only #2943 recurrence class).
  // Threshold is >=2 units (N>1 multi-sentence) — exactly two progress lines
  // must not bypass the gate.
  if (
    input.afterSubagentAnnounce &&
    units.length >= 2 &&
    looksLikeProgressOnly(units) &&
    failClass === "none"
  ) {
    failClass = "progress-only-no-tool";
    reasons.push(
      `progress-only-no-tool: post-subagent-announce turn has ${units.length} assistant ` +
        `text units with progress narration and zero tool_use/yield. MUST tool-first or yield. Refs #3131 / #2943.`,
    );
  }

  // Alias surface: FC14 and text-repetition-hang name the same hang class.
  if (failClass === "FC14") {
    // Keep failClass as FC14; callers may also match text-repetition-hang via reasons.
  }

  return {
    ok: failClass === "none",
    failClass,
    reasons,
    maxIdenticalCount,
    hasToolUse,
    hasYield,
  };
}

/** Convenience: true when the turn is an illegal text-repetition hang. */
export function isTextRepetitionHang(input: ParentTurnShapeInput): boolean {
  const r = evaluateParentTurnShape(input);
  return r.failClass === "FC14" || r.failClass === "text-repetition-hang";
}
