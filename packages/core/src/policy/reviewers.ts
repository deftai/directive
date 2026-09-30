/**
 * Typed plan.policy.review.reviewers (#3630).
 *
 * Explicit empty list is a zero-reviewer declaration (named terminal).
 * Unset means probe at PR time. Non-empty means a reviewer is expected
 * (slow path still polls). #769 substitution profiles are a different grain.
 */

import { readPlanPolicy } from "./plan-extensions.js";
import { loadProjectDefinition } from "./resolve.js";

export const FIELD_REVIEW_REVIEWERS = "plan.policy.review.reviewers";
export const FIELD_REVIEW_REVIEWERS_CLI_ALIAS = "reviewers";

export type ReviewersSource = "typed" | "unset" | "invalid";

export interface ReviewersResolved {
  /** null = unset (probe). Empty array = explicit zero. */
  readonly reviewers: readonly string[] | null;
  readonly source: ReviewersSource;
  readonly error: string | null;
}

function unset(error: string | null = null): ReviewersResolved {
  return { reviewers: null, source: "unset", error };
}

/**
 * Read nested plan.policy.review.reviewers from a policy block.
 * Returns undefined when the key is absent.
 */
export function readReviewersFromPolicyBlock(policyBlock: unknown): unknown | undefined {
  if (typeof policyBlock !== "object" || policyBlock === null || Array.isArray(policyBlock)) {
    return undefined;
  }
  const rec = policyBlock as Record<string, unknown>;
  if (!("review" in rec)) {
    return undefined;
  }
  const review = rec.review;
  if (typeof review !== "object" || review === null || Array.isArray(review)) {
    return undefined;
  }
  const reviewRec = review as Record<string, unknown>;
  if (!("reviewers" in reviewRec)) {
    return undefined;
  }
  return reviewRec.reviewers;
}

export function validateReviewers(raw: unknown): string | null {
  if (!Array.isArray(raw)) {
    return `${FIELD_REVIEW_REVIEWERS} must be an array of strings; got ${typeof raw}`;
  }
  if (!raw.every((item) => typeof item === "string")) {
    return `${FIELD_REVIEW_REVIEWERS} must be an array of strings`;
  }
  return null;
}

/**
 * Resolve plan.policy.review.reviewers.
 * Missing PROJECT-DEFINITION or missing key → unset (probe), not an implicit zero.
 */
export function resolveReviewers(projectRoot?: string | null): ReviewersResolved {
  if (projectRoot === undefined || projectRoot === null || projectRoot.length === 0) {
    return unset();
  }
  const [data, err] = loadProjectDefinition(projectRoot);
  if (data === null) {
    return unset(err);
  }
  const policyBlock = readPlanPolicy(data.plan);
  const raw = readReviewersFromPolicyBlock(policyBlock);
  if (raw === undefined) {
    return unset();
  }
  const validationError = validateReviewers(raw);
  if (validationError !== null) {
    return { reviewers: null, source: "invalid", error: validationError };
  }
  const rawList = raw as string[];
  const cleaned = rawList.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  // Explicit [] is the named zero (#3630). Blank-only entries (["", " "]) must
  // not collapse into that zero — fail closed to unset/probe (#5165 Greptile).
  if (rawList.length > 0 && cleaned.length === 0) {
    return {
      reviewers: null,
      source: "invalid",
      error: `${FIELD_REVIEW_REVIEWERS} has only blank entries; use [] for explicit zero or name a reviewer`,
    };
  }
  return { reviewers: cleaned, source: "typed", error: null };
}

export interface ReviewersPolicyField {
  readonly name: typeof FIELD_REVIEW_REVIEWERS;
  readonly current: readonly string[] | null;
  readonly default: null;
  readonly source: string;
}

export function inspectReviewers(
  _data: Record<string, unknown> | null,
  projectRoot?: string,
): ReviewersPolicyField {
  const resolved = resolveReviewers(projectRoot);
  return {
    name: FIELD_REVIEW_REVIEWERS,
    current: resolved.reviewers,
    default: null,
    source: resolved.source,
  };
}
