import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  VBRIEF_DEPRECATION_MARKER_FILENAME,
  VBRIEF_DEPRECATION_MARKER_SENTINEL,
} from "./constants.js";

/** True when `path` exists and is a directory; false on any stat error. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Placeholder files that do not count as real content when judging emptiness. */
const PLACEHOLDER_FILES = new Set([".gitkeep", ".keep"]);

/**
 * True when `dir` holds no meaningful content at any depth — a "fully migrated"
 * lifecycle root. Empty subdirectories and VCS placeholder files (`.gitkeep`,
 * `.keep`) are ignored, so a scaffolded-but-empty `vbrief/proposed/` tree still
 * counts as empty. A missing directory is trivially empty (#2270).
 */
export function isEffectivelyEmptyDir(dir: string): boolean {
  if (!isDirectory(dir)) {
    return true;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) {
      if (PLACEHOLDER_FILES.has(entry.name)) {
        continue;
      }
      return false;
    }
    // A symlink (to a file or dir) is real content: `isFile`/`isDirectory` both
    // report false for symlink dirents, so treat it explicitly as non-empty.
    if (entry.isSymbolicLink()) {
      return false;
    }
    if (entry.isDirectory() && !isEffectivelyEmptyDir(join(dir, entry.name))) {
      return false;
    }
  }
  return true;
}

/**
 * True when `dir` carries a deft-written deprecation marker identifying it as a
 * retained-for-read-compat legacy root rather than an active source of truth
 * (#2270). Matched on the sentinel so an unrelated `DEPRECATED.md` is ignored.
 */
export function hasVbriefDeprecationMarker(dir: string): boolean {
  try {
    return readFileSync(join(dir, VBRIEF_DEPRECATION_MARKER_FILENAME), "utf8").includes(
      VBRIEF_DEPRECATION_MARKER_SENTINEL,
    );
  } catch {
    return false;
  }
}
