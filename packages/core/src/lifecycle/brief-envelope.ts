/**
 * Shared document-envelope policy for lifecycle mutators (#3933).
 *
 * A brief carries one document envelope: `xBRIEFInfo` on canonical v0.8
 * artifacts, `vBRIEFInfo` on legacy v0.6 ones. A mutator stamps whichever
 * envelope the artifact already has and creates none. Creating one on a v0.8
 * brief appends a version-less `vBRIEFInfo`, and `validateVbriefSchema`
 * resolves `vBRIEFInfo` first, so the manufactured block wins and the brief the
 * mutator just wrote fails validation (#2346 / #2862 / #3933).
 */
import { LEGACY_INFO_ROOT_KEY, MIGRATED_INFO_ROOT_KEY } from "../xbrief-migrate/constants.js";

export type BriefEnvelopeKey = typeof MIGRATED_INFO_ROOT_KEY | typeof LEGACY_INFO_ROOT_KEY;

/** Envelope keys in canonical order: v0.8 first, legacy v0.6 second. */
export const BRIEF_ENVELOPE_KEYS: readonly BriefEnvelopeKey[] = [
  MIGRATED_INFO_ROOT_KEY,
  LEGACY_INFO_ROOT_KEY,
];

/** Envelope keys the artifact already carries as JSON objects. */
export function presentEnvelopeKeys(data: Record<string, unknown>): BriefEnvelopeKey[] {
  return BRIEF_ENVELOPE_KEYS.filter((key) => {
    const env = data[key];
    return typeof env === "object" && env !== null && !Array.isArray(env);
  });
}

/**
 * Stamp `updated` on every envelope the artifact already carries; create none.
 * Returns the stamped keys so a caller can refuse an envelope-less artifact by
 * name instead of manufacturing one.
 */
export function stampExistingEnvelopes(
  data: Record<string, unknown>,
  nowIso: string,
): BriefEnvelopeKey[] {
  const stamped = presentEnvelopeKeys(data);
  for (const key of stamped) {
    (data[key] as Record<string, unknown>).updated = nowIso;
  }
  return stamped;
}

/** Refusal naming both accepted envelopes, for a caller-supplied subject (#3933). */
export function missingEnvelopeMessage(subject: string): string {
  return (
    `${subject} carries neither \`${MIGRATED_INFO_ROOT_KEY}\` (v0.8) nor ` +
    `\`${LEGACY_INFO_ROOT_KEY}\` (v0.6) -- malformed. Lifecycle mutators refuse ` +
    "rather than create one (#3933)."
  );
}
