/** Canonical vBRIEF schema version exported for downstream contract imports. */
export const VBRIEF_VERSION = "0.6" as const;

export type VBriefVersion = typeof VBRIEF_VERSION;

/** npm package identity constant (stable across releases). */
export const TYPES_PACKAGE = "@deftai/directive-types" as const;

/**
 * vBRIEF#12 extension namespace — keys matching this pattern round-trip preserve-verbatim.
 * Namespaced form: `x-<namespace>/<rest>` (e.g. `x-directive/trace`, `x-vbrief/context`).
 * @see https://github.com/deftai/vBRIEF/issues/12
 */
export const EXTENSION_KEY_PATTERN = /^x-[a-z0-9-]+\//;

/** Prefix for schema-conformant vBRIEF reference `type` values. */
export const VBRIEF_REFERENCE_PREFIX = "x-vbrief/" as const;

/** JSON Schema `$id` for the v0.6 core document (published npm artifact). */
export const VBRIEF_CORE_SCHEMA_ID =
  "https://vbrief.dev/schemas/vbrief-core-0.6.schema.json" as const;
