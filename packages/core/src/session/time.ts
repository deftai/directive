/** Parse ISO-8601 timestamp (trailing Z or +00:00) into UTC Date. */
export function parseTimestamp(raw: unknown): Date | null {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  const normalised = raw.endsWith("Z") ? `${raw.slice(0, -1)}+00:00` : raw;
  const parsed = new Date(normalised);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

/** Format UTC instant as ``YYYY-MM-DDTHH:MM:SSZ`` (Python ritual writer shape). */
export function timestampIso(now?: Date): string {
  const instant = now ?? new Date();
  const iso = instant.toISOString();
  return iso.replace(/\.\d{3}Z$/, "Z");
}
