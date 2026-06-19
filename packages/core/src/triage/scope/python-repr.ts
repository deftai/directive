/** Python-style type name for validation error messages. */
export function pythonTypeName(value: unknown): string {
  if (value === null) return "None";
  if (Array.isArray(value)) return "list";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  if (typeof value === "string") return "str";
  if (typeof value === "object") return "dict";
  return typeof value;
}

/** Python repr for a string (single-quoted). */
export function pyStrRepr(value: string): string {
  return `'${value}'`;
}

/** Python repr for a list of strings (single-quoted elements). */
export function pyListRepr(items: readonly string[]): string {
  return `[${items.map((s) => `'${s}'`).join(", ")}]`;
}
