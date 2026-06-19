/** Format vBRIEF JSON like Python json.dumps(..., indent=2, ensure_ascii=False) + newline. */
export function formatVbriefJson(data: unknown): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

export function utcNowIso(now: Date = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}
