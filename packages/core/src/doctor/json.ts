/** JSON.dumps(..., sort_keys=True) with default separators. */
export function pythonJsonDump(value: unknown): string {
  const normalized = sortKeysDeep(value);
  return JSON.stringify(normalized, null, 0).replace(
    /("(?:[^"\\]|\\.)*")|([:,])/g,
    (_match, str: string | undefined, sep: string | undefined) =>
      str !== undefined ? str : sep === ":" ? ": " : ", ",
  );
}

function sortKeysDeep(value: unknown): unknown {
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
