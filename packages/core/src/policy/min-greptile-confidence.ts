/**
 * Typed plan.policy.review.minGreptileConfidence (#3095).
 *
 * CLEAN / merge-ready require Greptile confidence >= min (score out of 5).
 * Resolution order: explicit project policy > framework dogfood detect > consumer default.
 *
 * - Consumer default: 4 (legacy bar confidence > 3, i.e. 4/5 or 5/5)
 * - Directive dogfood (framework source checkout): 5 (5/5 required)
 */

import { isFrameworkRepoRoot } from "../check/context.js";
import { readPlanPolicy } from "./plan-extensions.js";
import { loadProjectDefinition } from "./resolve.js";

/** Canonical dotted path for policy:show / PROJECT-DEFINITION. */
export const FIELD_MIN_GREPTILE_CONFIDENCE = "plan.policy.review.minGreptileConfidence";

/** CLI alias for `task policy:show --field=minGreptileConfidence`. */
export const FIELD_MIN_GREPTILE_CONFIDENCE_CLI_ALIAS = "minGreptileConfidence";

/**
 * Consumer default minimum confidence that still CLEANs (#3095).
 * Matches the historical gate `confidence > 3` (i.e. score >= 4).
 */
export const DEFAULT_CONSUMER_MIN_GREPTILE_CONFIDENCE = 4;

/** Directive dogfood bar: CLEAN requires confidence == 5/5. */
export const DOGFOOD_MIN_GREPTILE_CONFIDENCE = 5;

export const MIN_GREPTILE_CONFIDENCE_FLOOR = 1;
export const MIN_GREPTILE_CONFIDENCE_CEILING = 5;

export type MinGreptileConfidenceSource = "typed" | "dogfood" | "default" | "default-on-error";

export interface MinGreptileConfidenceResolved {
  /** Minimum score (1–5) that satisfies CLEAN; score must be >= min. */
  readonly min: number;
  readonly source: MinGreptileConfidenceSource;
  readonly error: string | null;
}

function defaultResolved(
  source: MinGreptileConfidenceSource,
  min: number,
  error: string | null = null,
): MinGreptileConfidenceResolved {
  return { min, source, error };
}

/** True when score is present and meets the minimum floor. */
export function meetsMinGreptileConfidence(
  confidence: number | null | undefined,
  min: number,
): boolean {
  if (confidence === null || confidence === undefined) {
    return false;
  }
  return confidence >= min;
}

/** Human-facing phrase for the active bar (legacy "> 3" when min is 4). */
export function formatMinConfidenceRequirement(min: number): string {
  if (min === DEFAULT_CONSUMER_MIN_GREPTILE_CONFIDENCE) {
    return `> ${min - 1} (i.e. ${min}/5+)`;
  }
  return `>= ${min}/5`;
}

/** Validate a raw integer-ish min confidence value. */
export function validateMinGreptileConfidence(raw: unknown): string | null {
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    return `${FIELD_MIN_GREPTILE_CONFIDENCE} must be an integer ${MIN_GREPTILE_CONFIDENCE_FLOOR}–${MIN_GREPTILE_CONFIDENCE_CEILING}; got ${typeof raw}`;
  }
  if (raw < MIN_GREPTILE_CONFIDENCE_FLOOR || raw > MIN_GREPTILE_CONFIDENCE_CEILING) {
    return `${FIELD_MIN_GREPTILE_CONFIDENCE} must be between ${MIN_GREPTILE_CONFIDENCE_FLOOR} and ${MIN_GREPTILE_CONFIDENCE_CEILING}; got ${raw}`;
  }
  return null;
}

/**
 * Read nested plan.policy.review.minGreptileConfidence from a policy block.
 * Returns undefined when the key is absent.
 */
export function readMinGreptileConfidenceFromPolicyBlock(
  policyBlock: unknown,
): unknown | undefined {
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
  if (!("minGreptileConfidence" in reviewRec)) {
    return undefined;
  }
  return reviewRec.minGreptileConfidence;
}

/**
 * Resolve min Greptile confidence for CLEAN gates (#3095).
 *
 * 1. Explicit typed plan.policy.review.minGreptileConfidence
 * 2. Framework dogfood detection (framework source repo root) → 5
 * 3. Consumer default → 4
 */
export function resolveMinGreptileConfidence(
  projectRoot?: string | null,
): MinGreptileConfidenceResolved {
  if (projectRoot !== undefined && projectRoot !== null && projectRoot.length > 0) {
    const [data, err] = loadProjectDefinition(projectRoot);
    if (data !== null) {
      const policyBlock = readPlanPolicy(data.plan);
      const raw = readMinGreptileConfidenceFromPolicyBlock(policyBlock);
      if (raw !== undefined) {
        const validationError = validateMinGreptileConfidence(raw);
        if (validationError !== null) {
          // Invalid typed value: fall through to dogfood/default with error recorded.
          if (isFrameworkRepoRoot(projectRoot)) {
            return defaultResolved("dogfood", DOGFOOD_MIN_GREPTILE_CONFIDENCE, validationError);
          }
          return defaultResolved(
            "default-on-error",
            DEFAULT_CONSUMER_MIN_GREPTILE_CONFIDENCE,
            validationError,
          );
        }
        return defaultResolved("typed", raw as number, null);
      }
    } else if (err !== null && err.length > 0) {
      // Missing PROJECT-DEFINITION is not fatal; dogfood/default still apply.
      if (isFrameworkRepoRoot(projectRoot)) {
        return defaultResolved("dogfood", DOGFOOD_MIN_GREPTILE_CONFIDENCE, null);
      }
      return defaultResolved("default", DEFAULT_CONSUMER_MIN_GREPTILE_CONFIDENCE, err);
    }

    if (isFrameworkRepoRoot(projectRoot)) {
      return defaultResolved("dogfood", DOGFOOD_MIN_GREPTILE_CONFIDENCE, null);
    }
  }

  return defaultResolved("default", DEFAULT_CONSUMER_MIN_GREPTILE_CONFIDENCE, null);
}

export interface MinGreptileConfidencePolicyField {
  readonly name: typeof FIELD_MIN_GREPTILE_CONFIDENCE;
  readonly current: number;
  readonly default: number;
  readonly source: string;
}

/** Inspector row for `task policy:show --field=minGreptileConfidence` (#3095). */
export function inspectMinGreptileConfidence(
  _data: Record<string, unknown> | null,
  projectRoot?: string,
): MinGreptileConfidencePolicyField {
  const resolved = resolveMinGreptileConfidence(projectRoot);
  return {
    name: FIELD_MIN_GREPTILE_CONFIDENCE,
    current: resolved.min,
    default: DEFAULT_CONSUMER_MIN_GREPTILE_CONFIDENCE,
    source: resolved.source,
  };
}
