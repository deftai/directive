/** Python ``json.dumps(..., indent=2, ensure_ascii=False, sort_keys=False)`` + trailing newline. */
export function pythonJsonPretty(value: unknown, indent = 2): string {
  return `${JSON.stringify(value, null, indent)}\n`;
}
