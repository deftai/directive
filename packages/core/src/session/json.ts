import { expandPythonJsonSeparators } from "../text/redos-safe.js";

/** Recursively sort object keys to match Python ``json.dumps(..., sort_keys=True)``. */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortKeys(obj[key]);
    }
    return out;
  }
  return value;
}

/** Stable JSON text matching Python ritual-state writers (indent=2, sort_keys=True). */
export function stableJson(value: unknown, indent = 0): string {
  const normalized = sortKeys(value);
  if (indent > 0) {
    return `${JSON.stringify(normalized, null, indent)}\n`.slice(0, -1);
  }
  return expandPythonJsonSeparators(JSON.stringify(normalized));
}

/** Python ``json.dumps(..., sort_keys=True)`` compact form for verify JSON. */
export function pythonJsonDump(value: unknown): string {
  return stableJson(value, 0);
}
