import { EXTENSION_KEY_PATTERN } from "./constants.js";

/** Brand for vBRIEF#12 extension property keys (`x-*`). */
export type ExtensionKey = `x-${string}`;

/** Return true when `key` matches the vBRIEF#12 extension namespace. */
export function isExtensionKey(key: string): key is ExtensionKey {
  return EXTENSION_KEY_PATTERN.test(key);
}

/**
 * Preserve-verbatim round-trip helper: copy extension keys without transformation.
 * Core document keys are untouched; only `x-*` entries are collected.
 */
export function collectExtensionProperties(
  source: Record<string, unknown>,
): Record<ExtensionKey, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (isExtensionKey(key)) {
      out[key] = value;
    }
  }
  return out as Record<ExtensionKey, unknown>;
}
