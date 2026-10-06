/**
 * Plan.narratives source-provenance contract (#479).
 *
 * Named Source/Confidence vocabulary and the atomic claim unit live on
 * Plan.narratives. PlanItem.narrative stays an untyped string map.
 */
import { TRUST_LEVELS } from "@deftai/directive-types";
import { pyStrRepr, pythonTypeName } from "../triage/scope/python-repr.js";

export const SOURCE_CLASSES = [
  "verified",
  "observed",
  "inferred",
  "assumed",
  "propagated",
] as const;

export type SourceClass = (typeof SOURCE_CLASSES)[number];

export const CONFIDENCE_VALUES = ["high", "medium", "low"] as const;

export type ConfidenceValue = (typeof CONFIDENCE_VALUES)[number];

/** Named WARN class for legacy 0.8 Confidence strings (#5385 Prefer-A Bound). */
export const CONFIDENCE_COMPAT_WARN_CLASS = "Confidence-compat" as const;

export const CONFIDENCE_MIGRATE_COMMAND = "deft migrate:confidence" as const;

/** Named atomic-claim keys bound on the same Plan.narratives object. */
export const ATOMIC_CLAIM_KEYS = ["Evidence", "Verifier", "VerifiedAt"] as const;

const SOURCE_TOKEN_PATTERN = /^(verified|observed|inferred|assumed|propagated)(?::\s*\S.*)?$/;
const VERIFIED_AT_OFFSET = /(Z|[+-]\d{2}:\d{2})$/;
/** Unambiguous leading High/Medium/Low for migrate only — not the validate accept gate. */
const LEADING_CONFIDENCE_TOKEN = /^(high|medium|low)(?=$|[.\s,:;—–-]|(\.\s)|(\s+[-–—]))/i;
const AMBIGUOUS_LEADING_CONFIDENCE =
  /^(highly|higher|highest|medium-?high|medium-?low|high-?medium|high-?low|low-?medium|low-?high|low-?ish|lower|lowest)\b/i;
/** Whole-string ranges / compounds ("High or medium", "Medium-low", "high/medium"). */
const RANGE_OR_COMPOUND_CONFIDENCE =
  /^(high|medium|low)\s*(or|\/|to|through|thru|vs|versus|[-–—~,;])\s*(high|medium|low)\b|^(high|medium|low)[-–—](high|medium|low)\b/i;
/** Residual that binds to the leading token (High uncertainty ≠ high). */
const AMBIGUOUS_CONFIDENCE_RESIDUAL = /^(uncertainty|uncertain|confidence|likelihood)\b/i;
/** Ranges / alternatives after a leading token ("High or medium", "Medium-low"). */
const RANGE_OR_ALT_CONFIDENCE_RESIDUAL =
  /^(or|\/|to|through|thru|vs|versus)\s*(high|medium|low)\b|^[-–—~,;]\s*(high|medium|low)\b/i;

const SOURCE_CLASS_SET = new Set<string>(SOURCE_CLASSES);
const CONFIDENCE_SET = new Set<string>(CONFIDENCE_VALUES);
const TRUST_LEVEL_SET = new Set<string>(TRUST_LEVELS);

export function isCanonicalConfidence(value: unknown): value is ConfidenceValue {
  return typeof value === "string" && CONFIDENCE_SET.has(value);
}

/** Writers MUST emit only high|medium|low (#5385). Returned failure — no throw. */
export function requireCanonicalConfidence(
  value: unknown,
): { ok: true; value: ConfidenceValue } | { ok: false; error: string } {
  if (!isCanonicalConfidence(value)) {
    return {
      ok: false,
      error: `plan.narratives.Confidence writers MUST emit one of ${CONFIDENCE_VALUES.join(", ")}`,
    };
  }
  return { ok: true, value };
}

/**
 * Migrate assistance: map unambiguous leading High/Medium/Low (+ residual prose).
 * Declines ambiguous prefixes (Highly / High uncertainty). Not used by validate.
 */
export function extractLeadingConfidenceToken(
  value: string,
): { confidence: ConfidenceValue; residual: string } | null {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    AMBIGUOUS_LEADING_CONFIDENCE.test(trimmed) ||
    RANGE_OR_COMPOUND_CONFIDENCE.test(trimmed)
  ) {
    return null;
  }
  const match = LEADING_CONFIDENCE_TOKEN.exec(trimmed);
  const token = match?.[1];
  if (match === null || token === undefined) {
    return null;
  }
  const confidence = token.toLowerCase() as ConfidenceValue;
  const rawResidual = trimmed.slice(match[0].length);
  // Decline ranges before stripping separators so "Medium-low" / "High or medium" stay declined.
  if (RANGE_OR_ALT_CONFIDENCE_RESIDUAL.test(rawResidual.trimStart())) {
    return null;
  }
  const residual = rawResidual.replace(/^[.\s,:;—–-]+/, "").trim();
  if (AMBIGUOUS_CONFIDENCE_RESIDUAL.test(residual)) {
    return null;
  }
  // "High, medium" / "High medium" — residual is only the other enum (not prose).
  if (/^(high|medium|low)$/i.test(residual)) {
    return null;
  }
  return { confidence, residual };
}

export function formatConfidenceCompatWarning(path: string, confidence: string): string {
  return (
    `${CONFIDENCE_COMPAT_WARN_CLASS}: ${path}.Confidence legacy string ` +
    `${pyStrRepr(confidence)} (writers MUST emit ${CONFIDENCE_VALUES.join("|")}; ` +
    `optional ${CONFIDENCE_MIGRATE_COMMAND})`
  );
}

export function parseSourceTokens(source: string): string[] {
  return source
    .split(";")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

export function sourceTokenClass(token: string): SourceClass | null {
  const colon = token.indexOf(":");
  const head = (colon === -1 ? token : token.slice(0, colon)).trim();
  return SOURCE_CLASS_SET.has(head) ? (head as SourceClass) : null;
}

export function isSourceToken(token: string): boolean {
  return SOURCE_TOKEN_PATTERN.test(token);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isVerifiedAt(value: string): boolean {
  if (!VERIFIED_AT_OFFSET.test(value)) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}

function sourceIsPureNamedClass(source: unknown): boolean {
  if (!isNonEmptyString(source)) {
    return false;
  }
  const tokens = parseSourceTokens(source);
  return tokens.length > 0 && tokens.every((token) => sourceTokenClass(token) !== null);
}

function claimUnitKeysBind(narratives: Record<string, unknown>): boolean {
  // Verifier/VerifiedAt are claim-unit-only. Key presence (including "") binds.
  // Evidence is also a mission-style section and does not bind alone.
  return "Verifier" in narratives || "VerifiedAt" in narratives;
}

function atomicClaimPresent(narratives: Record<string, unknown>): boolean {
  if (sourceIsPureNamedClass(narratives.Source) || claimUnitKeysBind(narratives)) {
    return true;
  }
  // Evidence binds the unit only with Source (mission style uses Evidence without Source).
  return isNonEmptyString(narratives.Evidence) && isNonEmptyString(narratives.Source);
}

export interface ProvenanceOptions {
  /**
   * Terminal records keep unkeyed historical Source readable
   * (#3383 / #5385 / vbrief.md ~). Does not suppress Confidence-compat WARN.
   */
  readonly grandfatherUnkeyed?: boolean;
  /** Sink for named Confidence-compat WARN (#5385 Prefer-A Bound). */
  readonly warnings?: string[];
}

/**
 * Validate Plan.narratives Source/Confidence vocabulary and atomic claim unit.
 * Grandfathers historical Source strings that are not named-class tokens.
 * Legacy Confidence strings warn (0.8 read compat); writers still emit enum.
 */
export function validatePlanNarrativesProvenance(
  narratives: unknown,
  path: string,
  errors: string[],
  options?: ProvenanceOptions,
): void {
  if (typeof narratives !== "object" || narratives === null || Array.isArray(narratives)) {
    return;
  }
  const n = narratives as Record<string, unknown>;

  if ("Confidence" in n) {
    const confidence = n.Confidence;
    if (typeof confidence !== "string") {
      errors.push(
        `${path}.Confidence invalid: ${pyStrRepr(String(confidence))} ` +
          `(expected one of ${CONFIDENCE_VALUES.join(", ")})`,
      );
    } else if (!CONFIDENCE_SET.has(confidence)) {
      // Classification-only: never rewrite in-memory or on-disk (#5385).
      const warnings = options?.warnings;
      if (warnings !== undefined) {
        warnings.push(formatConfidenceCompatWarning(path, confidence));
      }
    }
  }

  if (options?.grandfatherUnkeyed && !claimUnitKeysBind(n)) {
    return;
  }

  if (!atomicClaimPresent(n)) {
    return;
  }

  const source = n.Source;
  if (!isNonEmptyString(source)) {
    errors.push(
      `${path}.Source is required when Evidence, Verifier, or VerifiedAt is present ` +
        `(atomic claim unit)`,
    );
    return;
  }

  const tokens = parseSourceTokens(source);
  if (tokens.length === 0) {
    errors.push(`${path}.Source must contain at least one source-class token`);
    return;
  }

  for (const token of tokens) {
    if (!isSourceToken(token)) {
      errors.push(
        `${path}.Source token ${pyStrRepr(token)} is not a named class ` +
          `(verified|observed|inferred|assumed|propagated, optional :<method>)`,
      );
    }
  }

  const classes = tokens.map(sourceTokenClass).filter((c): c is SourceClass => c !== null);
  const verified = classes.includes("verified");
  if (!verified) {
    return;
  }

  if (!isNonEmptyString(n.Evidence)) {
    const confidencePresent = "Confidence" in n;
    errors.push(
      `${path}.Evidence is required when Source includes class verified` +
        (confidencePresent ? " (Confidence does not substitute for evidence)" : ""),
    );
  }
  if (!isNonEmptyString(n.Verifier)) {
    errors.push(`${path}.Verifier is required when Source includes class verified`);
  }
  if (!isNonEmptyString(n.VerifiedAt)) {
    errors.push(`${path}.VerifiedAt is required when Source includes class verified`);
  } else if (!isVerifiedAt(n.VerifiedAt)) {
    errors.push(
      `${path}.VerifiedAt invalid: ${pyStrRepr(n.VerifiedAt)} ` +
        `(expected ISO-8601 date-time with Z or numeric offset)`,
    );
  }
}

/** Validate references[].TrustLevel when present (#480 / #479). */
export function validateReferenceTrustLevels(
  references: unknown,
  filepath: string,
  errors: string[],
): void {
  if (!Array.isArray(references)) {
    return;
  }
  for (let i = 0; i < references.length; i += 1) {
    const ref = references[i];
    if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
      continue;
    }
    if (!("TrustLevel" in ref)) {
      continue;
    }
    const trust = (ref as Record<string, unknown>).TrustLevel;
    if (typeof trust !== "string" || !TRUST_LEVEL_SET.has(trust)) {
      errors.push(
        `${filepath}: plan.references[${i}].TrustLevel invalid: ` +
          `${typeof trust !== "string" ? pythonTypeName(trust) : pyStrRepr(trust)} ` +
          `(expected one of ${TRUST_LEVELS.join(", ")})`,
      );
    }
  }
}
