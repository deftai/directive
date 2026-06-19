import { expandPythonJsonSeparators } from "../text/redos-safe.js";

/** Format values like Python `repr()` for golden parity with the oracle. */
export function pyRepr(value: unknown): string {
  if (value === null) {
    return "None";
  }
  if (typeof value === "string") {
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => pyRepr(item)).join(", ")}]`;
  }
  return JSON.stringify(value);
}

/** Format a tuple like Python `('a', 'b')` including trailing comma for length 1. */
export function pyTuple(items: readonly unknown[]): string {
  if (items.length === 1) {
    return `(${pyRepr(items[0])},)`;
  }
  return `(${items.map((item) => pyRepr(item)).join(", ")})`;
}

/** JSON.dumps(..., ensure_ascii=False) default separators: ', ' and ': '.
 * Only structural separators are expanded -- colons/commas inside string
 * literals are preserved so values like "fix: bug" or "foo, bar" survive. */
export function pythonJsonStringify(value: unknown): string {
  return expandPythonJsonSeparators(JSON.stringify(value, null, 0));
}
