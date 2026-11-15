/**
 * One path test for changelog entry paths (#6314 / #6286 item 1).
 *
 * A changelog entry path is exactly root `CHANGELOG.md` or one fragment file
 * `changelog.d/<name>.md`, one segment deep, where `<name>` is lowercase
 * letters, digits, `.`, `_` or `-`. Every check that used to match the literal
 * `CHANGELOG.md` as a path calls this function instead, so the family cannot
 * drift between checks. The contract test `entry-path-contract.test.ts` fails
 * on a new literal path match outside this module.
 *
 * Input is a repository-relative POSIX path. Callers keep their own
 * normalization (backslashes, leading `./`); this test does not guess.
 */

/** Root changelog file (repository-relative). */
export const CHANGELOG_FILE_REL = "CHANGELOG.md";

/** Fragment directory (repository-relative, no trailing slash). */
export const CHANGELOG_FRAGMENT_DIR = "changelog.d";

const FRAGMENT_PATH_RE = /^changelog\.d\/[a-z0-9._-]+\.md$/;

/** True for exactly `CHANGELOG.md` and for `changelog.d/<name>.md` (one segment deep). */
export function isChangelogEntryPath(relPath: string): boolean {
  return relPath === CHANGELOG_FILE_REL || FRAGMENT_PATH_RE.test(relPath);
}

/** True for a fragment path `changelog.d/<name>.md` only (not `CHANGELOG.md`). */
export function isChangelogFragmentPath(relPath: string): boolean {
  return FRAGMENT_PATH_RE.test(relPath);
}
