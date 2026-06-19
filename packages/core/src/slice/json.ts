/** Recursively sort object keys like Python json.dumps(..., sort_keys=True). */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortKeysDeep(item));
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeysDeep(obj[key]);
    }
    return sorted;
  }
  return value;
}

/** JSON.dumps(..., sort_keys=True, ensure_ascii=False) with Python separators. */
export function pythonJsonStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value)).replace(
    /("(?:[^"\\]|\\.)*")|([:,])/g,
    (_match, str: string | undefined, sep: string | undefined) =>
      str !== undefined ? str : sep === ":" ? ": " : ", ",
  );
}

/** JSON.dumps(..., sort_keys=True, ensure_ascii=False, indent=2). */
export function pythonJsonPretty(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value), null, 2);
}
