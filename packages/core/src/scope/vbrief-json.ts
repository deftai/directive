export { formatBriefJson } from "./brief-io.js";

export function utcNowIso(now: Date = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}
