/**
 * Closed lexicon of explicit operator scope-limit phrases (#4545).
 * Detection is case-insensitive substring match; longest match wins.
 */

/** Phrases ordered longest-first so close variants beat shorter stems. */
export const SCOPE_LIMIT_PHRASES: readonly string[] = [
  "do not add features beyond the requirements",
  "do not add features beyond",
  "nothing beyond the requirements",
  "initial version only",
  "nothing beyond",
  "do not add",
];
