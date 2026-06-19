/** Python ``!r`` / ``repr()`` for strings used in conflict messages. */
export function pyRepr(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}
