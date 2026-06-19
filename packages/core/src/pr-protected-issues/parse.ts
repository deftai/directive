/**
 * Flatten comma-separated and repeated ``--protected`` flags into a sorted,
 * deduplicated list. Raises on non-decimal tokens (mirrors Python ``isdecimal()``).
 */
export function parseProtected(values: readonly string[]): number[] {
  const out = new Set<number>();
  for (const chunk of values) {
    for (const raw of chunk.split(",")) {
      const tok = raw.trim().replace(/^#/, "");
      if (tok.length === 0) {
        continue;
      }
      if (!/^[0-9]+$/.test(tok)) {
        throw new Error(`Invalid protected issue token: '${tok}'`);
      }
      out.add(Number(tok));
    }
  }
  return [...out].sort((a, b) => a - b);
}
