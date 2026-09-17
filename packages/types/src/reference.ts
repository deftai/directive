import { VBRIEF_REFERENCE_PREFIX, XBRIEF_REFERENCE_PREFIX } from "./constants.js";

/** Canonical reference types from conventions/references.md (non-exhaustive). */
export const KNOWN_REFERENCE_TYPES = [
  "x-vbrief/plan",
  "x-vbrief/github-issue",
  "x-vbrief/github-pr",
  "x-vbrief/jira-ticket",
  "x-vbrief/user-request",
  "x-vbrief/spec-section",
  "x-vbrief/context",
  "x-vbrief/research",
  "x-xbrief/plan",
  "x-xbrief/github-issue",
  "x-xbrief/github-pr",
  "x-xbrief/jira-ticket",
  "x-xbrief/user-request",
  "x-xbrief/spec-section",
  "x-xbrief/commit",
  "x-xbrief/context",
  "x-xbrief/external",
  "x-xbrief/research",
  "x-xbrief/adr",
] as const;

export type KnownReferenceType = (typeof KNOWN_REFERENCE_TYPES)[number];

export type TrustLevel = "internal" | "external";

/** Schema-conformant vBRIEF/xBRIEF reference (`VBriefReference` in core schema). */
export interface VBriefReference {
  readonly uri: string;
  readonly type:
    | `${typeof VBRIEF_REFERENCE_PREFIX}${string}`
    | `${typeof XBRIEF_REFERENCE_PREFIX}${string}`
    | KnownReferenceType;
  readonly title?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  /** Canonical JSON key per vbrief.md TrustLevel (#480); not camelCase `trustLevel`. */
  readonly TrustLevel?: TrustLevel;
  readonly [key: `x-${string}`]: unknown;
}

/** Return true when `type` is a schema-conformant `x-vbrief/*` or `x-xbrief/*` reference type. */
export function isVBriefReferenceType(type: string): boolean {
  return type.startsWith(VBRIEF_REFERENCE_PREFIX) || type.startsWith(XBRIEF_REFERENCE_PREFIX);
}

/**
 * Return true when `value` matches either the legacy `x-vbrief/<bareType>` or
 * the canonical `x-xbrief/<bareType>` form.  Use this for all reader/matcher
 * comparisons so that both namespaces are accepted during the transition
 * period while `x-vbrief/` remains read-accepted for consumer back-compat.
 */
export function referenceTypeMatches(value: string, bareType: string): boolean {
  return (
    value === `${VBRIEF_REFERENCE_PREFIX}${bareType}` ||
    value === `${XBRIEF_REFERENCE_PREFIX}${bareType}`
  );
}

/**
 * Near-miss reserved subtypes mapped to the canonical bare type (#4698).
 * Same class as ITEM_STATUS_ALIASES (complete -> completed): a synonym
 * map, not a fifth type registry.
 */
export const RESERVED_REFERENCE_TYPE_ALIASES: Readonly<Record<string, string>> = {
  "pull-request": "github-pr",
  "github-pull-request": "github-pr",
};

export interface UnknownReservedReferenceType {
  readonly type: string;
  readonly subtype: string;
  readonly nearestCanonical: string | null;
}

function reservedPrefixOf(
  type: string,
): typeof VBRIEF_REFERENCE_PREFIX | typeof XBRIEF_REFERENCE_PREFIX | null {
  if (type.startsWith(XBRIEF_REFERENCE_PREFIX)) {
    return XBRIEF_REFERENCE_PREFIX;
  }
  if (type.startsWith(VBRIEF_REFERENCE_PREFIX)) {
    return VBRIEF_REFERENCE_PREFIX;
  }
  return null;
}

/**
 * True when type is a reserved-prefix value already consumed by existing
 * lists: KNOWN_REFERENCE_TYPES (conventions registry) or engine-written
 * closes / blocks / refs / current-shape via referenceTypeMatches.
 * Not a closed set of KNOWN alone (#4698).
 */
export function isRecognizedReservedReferenceType(type: string): boolean {
  if ((KNOWN_REFERENCE_TYPES as readonly string[]).includes(type)) {
    return true;
  }
  return (
    referenceTypeMatches(type, "closes") ||
    referenceTypeMatches(type, "blocks") ||
    referenceTypeMatches(type, "refs") ||
    referenceTypeMatches(type, "current-shape") ||
    referenceTypeMatches(type, "web-page")
  );
}

/**
 * Describe a reserved x-xbrief/ or x-vbrief/ subtype that no existing
 * matcher list consumes. Consumer namespaces (x-myapp/...) are not reserved
 * and return null. Silent skip of a reserved unknown is fail-open (#4698).
 */
export function describeUnknownReservedReferenceType(
  type: string,
): UnknownReservedReferenceType | null {
  const prefix = reservedPrefixOf(type);
  if (prefix === null) {
    return null;
  }
  if (isRecognizedReservedReferenceType(type)) {
    return null;
  }
  const subtype = type.slice(prefix.length);
  const aliasedBare = RESERVED_REFERENCE_TYPE_ALIASES[subtype];
  return {
    type,
    subtype,
    nearestCanonical: aliasedBare === undefined ? null : `${prefix}${aliasedBare}`,
  };
}
