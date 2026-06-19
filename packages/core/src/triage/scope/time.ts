/** UTC ISO-8601 stamp with trailing Z, mirroring Python `_utc_iso`. */
export function utcIso(dt: Date | null = null): string {
  const value = dt ?? new Date();
  const iso = value.toISOString();
  return iso.replace(/\.\d{3}Z$/, "Z");
}

/** Parse ISO-8601 stamp (with Z suffix) into Date. */
export function parseIso(stamp: string): Date {
  let text = stamp.trim();
  if (text.endsWith("Z")) {
    text = `${text.slice(0, -1)}+00:00`;
  }
  return new Date(text);
}

export function utcNow(): Date {
  return new Date();
}
