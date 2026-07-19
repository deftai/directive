import {
  assertProjectionContained,
  ProjectionContainmentError,
  walkDirectoryRejectSymlinks,
} from "../fs/projection-containment.js";

/**
 * Refuse migrate:xbrief when legacy `vbrief/` (or any traversed entry) escapes
 * the project tree via symlinks (#2601).
 */
export function assertMigrationSourceSafe(projectRoot: string, legacyDir: string): void {
  assertProjectionContained(projectRoot, legacyDir);
  try {
    walkDirectoryRejectSymlinks(legacyDir);
  } catch (err) {
    if (err instanceof ProjectionContainmentError) {
      const nested = err.message.match(/symlink on traversal path: (.+)$/);
      if (nested) {
        throw new Error(`refusing to migrate: symlink on migration path: ${nested[1]}`);
      }
    }
    throw err;
  }
}
