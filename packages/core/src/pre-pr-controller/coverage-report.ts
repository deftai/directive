/**
 * One coverage report path for the bound pre-PR run and `coverage:hotspots`,
 * with presence by lstat (never following a symlink) and a no-follow read.
 * Every helper is total: any error maps to the refuse value (`null`).
 */

import { constants, lstatSync, realpathSync } from "node:fs";
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
 * (ELOOP), a non-regular file, or any error returns null. win32 has no
 * O_NOFOLLOW: lstat presence plus the fstat check on the opened fd.
 */
export function readCoverageReportNoFollow(path: string): string | null {
  const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW;
  if (noFollow === undefined && coverageReportPresence(path) !== "present") {
    return null;
  }
  return readRegularFileNoFollow(path);
}
