import { type Dirent, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assertProjectionContained } from "../fs/projection-containment.js";

/**
 * Refuse migrate:xbrief when legacy `vbrief/` (or any traversed entry) escapes
 * the project tree via symlinks (#2601).
 */
export function assertMigrationSourceSafe(projectRoot: string, legacyDir: string): void {
  assertProjectionContained(projectRoot, legacyDir);
  walkMigrationTreeRejectSymlinks(legacyDir);
}

function walkMigrationTreeRejectSymlinks(root: string): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(full);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`refusing to migrate: symlink on migration path: ${full}`);
    }
    if (info.isDirectory()) {
      walkMigrationTreeRejectSymlinks(full);
    }
  }
}
