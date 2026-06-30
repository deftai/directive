/** Canonical xBRIEF schema version exported for downstream contract imports. */
export const VBRIEF_VERSION = "0.8" as const;

export type VBriefVersion = typeof VBRIEF_VERSION;

/** Legacy v0.6 envelope version still accepted by the validator (additive back-compat). */
export const LEGACY_VBRIEF_VERSION = "0.6" as const;

/** All `*BRIEFInfo.version` values the engine accepts at validation time. */
export const ACCEPTED_VBRIEF_VERSIONS = [LEGACY_VBRIEF_VERSION, VBRIEF_VERSION] as const;

/** npm package identity constant (stable across releases). */
export const TYPES_PACKAGE = "@deftai/directive-types" as const;

/**
 * xBRIEF#12 extension namespace — keys matching this pattern round-trip preserve-verbatim.
 * Namespaced form: `x-<namespace>/<rest>` (e.g. `x-directive/trace`, `x-xbrief/context`).
 * @see https://github.com/deftai/vBRIEF/issues/12
 */
export const EXTENSION_KEY_PATTERN = /^x-[a-z0-9-]+\//;

/** Legacy prefix for schema-conformant v0.6 reference `type` values (still accepted). */
export const VBRIEF_REFERENCE_PREFIX = "x-vbrief/" as const;

/** Canonical prefix for schema-conformant v0.8 reference `type` values. */
export const XBRIEF_REFERENCE_PREFIX = "x-xbrief/" as const;

/** JSON Schema `$id` for the v0.6 core document (legacy npm artifact). */
export const LEGACY_VBRIEF_CORE_SCHEMA_ID =
  "https://vbrief.dev/schemas/vbrief-core-0.6.schema.json" as const;

/** JSON Schema `$id` for the v0.8 core document (published npm artifact). */
export const VBRIEF_CORE_SCHEMA_ID =
  "https://xbrief.dev/schemas/xbrief-core-0.8.schema.json" as const;
