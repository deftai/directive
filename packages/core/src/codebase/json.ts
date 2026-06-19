/** Deep-sort object keys (mirrors Python json.dumps sort_keys=True). */
export function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sortKeysDeep(item));
  }
  const rec = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(rec).sort()) {
    out[key] = sortKeysDeep(rec[key]);
  }
  return out;
}

/** JSON.stringify with sorted keys and 2-space indent (mirrors Python sort_keys + indent=2). */
export function sortedStringifyPretty(value: unknown): string {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}

/** Compact JSON with sorted keys (mirrors Python json.dumps sort_keys=True). */
export function sortedStringifyCompact(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value))
    .replace(/,/g, ", ")
    .replace(/:(?=["[\-{0-9ntf])/g, ": ");
}
