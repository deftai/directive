/**
 * One coverage report path for the bound pre-PR run and `coverage:hotspots`,
 * with presence by lstat (never following a symlink) and a no-follow read.
 * Every helper is total: any error maps to the refuse value (`null`).
 */

import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { readRegularFileNoFollow } from "../fs/contained-write.js";

/** `<projectRoot>/coverage/coverage-final.json`, the one path every pre-PR arm checks. */
export function prePrCoverageReportPath(projectRoot: string): string {
  return join(projectRoot, "coverage", "coverage-final.json");
}

/**
 * `present` for a regular file, `absent` for ENOENT, `null` (refuse) for a
 * symlink, directory, other file type, or any other lstat error.
 */
export function coverageReportPresence(path: string): "absent" | "present" | null {
  try {
    const st = lstatSync(path);
    return st.isFile() ? "present" : null;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : null;
  }
}

/** `realpath(projectRoot)`, or null on any error. A consistency check, not an authenticator. */
export function resolveObservedRoot(projectRoot: string): string | null {
  try {
    return realpathSync(projectRoot);
  } catch {
    return null;
  }
}

/**
 * Read the report through one fd opened with O_NOFOLLOW, only if that fd is a
 * regular file ({@link readRegularFileNoFollow}). A symlinked final component
 * (ELOOP), a non-regular file, or any error returns null.
 *
 * Windows decision (#7203): win32 refuses a symlink swap at this read too. It
 * has no O_NOFOLLOW, so the read lstats the path, opens it, and refuses unless
 * the opened fd is the same regular file the lstat saw (same dev and ino). A
 * symlink swapped in after the lstat opens another file and is refused.
 */
export function readCoverageReportNoFollow(path: string): string | null {
  return readRegularFileNoFollow(path);
}
