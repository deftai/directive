import { pythonJsonPretty } from "../vbrief-build/json.js";

/** Canonical brief JSON formatting — delegates to vbrief-build serializer (#2131). */
export const formatBriefJson = pythonJsonPretty;

/** @deprecated Use formatBriefJson — retained for existing test/fixture imports. */
export const formatVbriefJson = pythonJsonPretty;

export function utcNowIso(now: Date = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}
