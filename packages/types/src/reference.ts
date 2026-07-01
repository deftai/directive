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
