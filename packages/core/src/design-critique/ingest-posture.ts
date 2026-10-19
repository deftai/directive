/**
 * Pre-ingest design-critique posture (#5716 Prefer-A Recut-3).
 *
 * Three-state denominator for issue:ingest / triage:accept: arced |
 * skipped-recorded | neither. Blocked / in-flight are excluded.
 * Skip predicate is operative not-warranted only — not full CLEARANCE_SHAPE.
 */
import { classifyPosition } from "./citation-grammar.js";
import type { CompletedArcVerdict, ThreadComment } from "./completed-arc-record.js";

/** Closed three-state postures emitted on design_critique_ingest_posture. */
export const DESIGN_CRITIQUE_INGEST_POSTURES = ["arced", "skipped-recorded", "neither"] as const;
export type DesignCritiqueIngestPosture = (typeof DESIGN_CRITIQUE_INGEST_POSTURES)[number];

/**
 * Operative not-warranted skip line. Requires a non-empty because-clause token
 * for shape; content is never scored. Do not reuse DESIGN_CRITIQUE_CLEARANCE_SHAPE
 * (warranted|not warranted) as this skip predicate.
 */
export const DESIGN_CRITIQUE_NOT_WARRANTED_SKIP_RE =
  /(?:^|\n)[ \t]*design-critique:\s*not warranted,\s*because\s+\S/gi;

const NOT_WARRANTED_TOKEN = "design-critique:";

/** Advisory printed only for neither; exit code unchanged. */
export const DESIGN_CRITIQUE_INGEST_ADVISORY =
  "advisory: before issue:ingest, run deft-directive-design-critique (arc) or record " +
  "design-critique: not warranted, because … (exit 0; never blocks)";

function operativeMatchOffset(match: RegExpMatchArray): number {
  const matchOffset = match.index ?? 0;
  const inner = match[0].search(NOT_WARRANTED_TOKEN);
  return matchOffset + (inner >= 0 ? inner : 0);
}

/** True when body/comments carry an operative not-warranted skip line. */
export function hasOperativeNotWarrantedSkip(
  issueBody: string | null | undefined,
  comments: readonly ThreadComment[],
): boolean {
  const texts: string[] = [];
  if (typeof issueBody === "string" && issueBody.length > 0) {
    texts.push(issueBody);
  }
  for (const comment of comments) {
    if (typeof comment.body === "string" && comment.body.length > 0) {
      texts.push(comment.body);
    }
  }
  for (const text of texts) {
    const re = new RegExp(
      DESIGN_CRITIQUE_NOT_WARRANTED_SKIP_RE.source,
      DESIGN_CRITIQUE_NOT_WARRANTED_SKIP_RE.flags,
    );
    for (const match of text.matchAll(re)) {
      if (classifyPosition(text, operativeMatchOffset(match)) === null) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Classify ingest posture for the three-state denominator.
 * complete → arced (wins over stale skip text).
 * not-in-arc + operative not-warranted → skipped-recorded.
 * not-in-arc otherwise (including warranted-only) → neither.
 * blocked → null (excluded from denominator).
 */
export function classifyDesignCritiqueIngestPosture(input: {
  readonly verdict: CompletedArcVerdict;
  readonly issueBody?: string | null;
  readonly comments: readonly ThreadComment[];
}): DesignCritiqueIngestPosture | null {
  if (input.verdict.status === "complete") {
    return "arced";
  }
  if (input.verdict.status === "blocked") {
    return null;
  }
  if (hasOperativeNotWarrantedSkip(input.issueBody, input.comments)) {
    return "skipped-recorded";
  }
  return "neither";
}
