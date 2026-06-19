/** Recursively sort object keys like Python `json.dumps(..., sort_keys=True)`. */
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

/** Python ``True`` / ``False`` literals for CLI parity. */
export function pythonBool(value: boolean): string {
  return value ? "True" : "False";
}

/** Python `json.dumps(..., indent=2, sort_keys=True, ensure_ascii=False)`. */
export function pythonJsonDump(value: unknown, indent = 2): string {
  return `${JSON.stringify(sortKeysDeep(value), null, indent)}\n`.slice(0, -1);
}

/** Python audit-line / fetch report `json.dumps(..., ensure_ascii=False, sort_keys=True)`. */
export function pythonJsonLine(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

/** Python CLI `json.dumps(..., indent=2, ensure_ascii=False)` without sort_keys. */
export function pythonJsonPretty(value: unknown, indent = 2): string {
  return JSON.stringify(value, null, indent);
}
