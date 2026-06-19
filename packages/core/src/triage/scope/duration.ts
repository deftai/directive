const DURATION_RE_SIMPLE = /^\s*(\d+)\s*([smhdw])\s*$/i;
const DURATION_RE_ISO = /^P(?:(?:(\d+)D))?(?:T(?:(?:(\d+)H))?(?:(?:(\d+)M))?(?:(?:(\d+)S))?)?$/i;

function scaleDuration(n: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u === "s") return n * 1000;
  if (u === "m") return n * 60 * 1000;
  if (u === "h") return n * 60 * 60 * 1000;
  if (u === "d") return n * 24 * 60 * 60 * 1000;
  if (u === "w") return n * 7 * 24 * 60 * 60 * 1000;
  throw new Error(`unknown duration unit ${unit}`);
}

/** Parse duration string into milliseconds (Python timedelta equivalent). */
export function parseDurationMs(raw: unknown): number {
  if (typeof raw !== "string") {
    throw new Error(`duration must be a string, got ${typeof raw}`);
  }
  const text = raw.trim();
  if (!text) {
    throw new Error("duration must be a non-empty string");
  }

  const simple = DURATION_RE_SIMPLE.exec(text);
  if (simple) {
    return scaleDuration(Number(simple[1]), simple[2] ?? "s");
  }

  const iso = DURATION_RE_ISO.exec(text);
  if (iso && (iso[1] ?? iso[2] ?? iso[3] ?? iso[4])) {
    const days = Number(iso[1] ?? 0);
    const hours = Number(iso[2] ?? 0);
    const minutes = Number(iso[3] ?? 0);
    const seconds = Number(iso[4] ?? 0);
    return (
      days * 24 * 60 * 60 * 1000 + hours * 60 * 60 * 1000 + minutes * 60 * 1000 + seconds * 1000
    );
  }

  throw new Error(
    `invalid duration ${JSON.stringify(raw)}: expected '<N>(s|m|h|d|w)' ` +
      "(e.g. '7d', '24h') or ISO-8601 'PnDTnHnMnS' (e.g. 'P7D', 'PT24H')",
  );
}

export function parseDuration(raw: unknown): { ms: number } {
  return { ms: parseDurationMs(raw) };
}
