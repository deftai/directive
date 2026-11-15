/**
 * Read-only CHANGELOG node-type guard for release Step 5 (#4318 / #4164).
 *
 * Symlink-ancestor floor is assertDestinationNotSymlink. Leaf node-type is a
 * regular file. This is not nlink / pair-identity (Step 6) and not containedWrite.
 */
import { type BigIntStats, lstatSync } from "node:fs";
import { join } from "node:path";
import {
  assertDestinationNotSymlink,
  ProjectionContainmentError,
} from "../fs/projection-containment.js";
import { EXIT_CONFIG_ERROR, EXIT_VIOLATION } from "./constants.js";

export type ChangelogSafetyOk = { readonly ok: true };
export type ChangelogSafetyFail = {
  readonly ok: false;
  readonly exitCode: number;
  readonly code: string;
  readonly message: string;
};
export type ChangelogSafetyResult = ChangelogSafetyOk | ChangelogSafetyFail;

export function changelogPathOf(projectRoot: string): string {
  return join(projectRoot, "CHANGELOG.md");
}

export function roadmapPathOf(projectRoot: string): string {
  return join(projectRoot, "ROADMAP.md");
}

export function safetyFail(exitCode: number, code: string, message: string): ChangelogSafetyFail {
  return { ok: false, exitCode, code, message };
}

/** Leaf kind that is not a regular file, or null when the leaf is a regular file. */
export function classifyReleaseLeaf(stats: BigIntStats): string | null {
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isFIFO()) return "fifo";
  if (stats.isDirectory()) return "directory";
  if (stats.isSocket() || stats.isCharacterDevice() || stats.isBlockDevice()) return "special";
  if (!stats.isFile()) return "not-file";
  return null;
}

export function symlinkAncestorFloor(
  projectRoot: string,
  targetPath: string,
): ChangelogSafetyResult {
  try {
    assertDestinationNotSymlink(projectRoot, targetPath);
    return { ok: true };
  } catch (err) {
    if (err instanceof ProjectionContainmentError) {
      return safetyFail(EXIT_VIOLATION, "symlink", err.message);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return safetyFail(EXIT_VIOLATION, "unsafe", msg);
  }
}

function leafRefusalMessage(label: string, kind: string): string {
  if (kind === "fifo") return `${label} is a FIFO; release reads require a regular file`;
  if (kind === "directory") return `${label} is a directory; release reads require a regular file`;
  if (kind === "symlink") return `${label} is a symlink; release reads require a regular file`;
  if (kind === "special") return `${label} is a special node; release reads require a regular file`;
  return `${label} is not a regular file`;
}

/**
 * Read-only structural check before any release-owned CHANGELOG payload read.
 * Missing CHANGELOG is config 2; detected policy refusal is 1.
 */
export function guardChangelogReadSafety(projectRoot: string): ChangelogSafetyResult {
  const changelogPath = changelogPathOf(projectRoot);
  const floor = symlinkAncestorFloor(projectRoot, changelogPath);
  if (!floor.ok) return floor;

  let stats: BigIntStats;
  try {
    stats = lstatSync(changelogPath, { bigint: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return safetyFail(EXIT_CONFIG_ERROR, "missing", `CHANGELOG.md not found at ${changelogPath}`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return safetyFail(EXIT_VIOLATION, "unsafe", msg);
  }

  const kind = classifyReleaseLeaf(stats);
  if (kind !== null) {
    return safetyFail(EXIT_VIOLATION, kind, leafRefusalMessage("CHANGELOG.md", kind));
  }
  return { ok: true };
}

/**
 * The same read-safety refusal for one `changelog.d/` fragment (#6315): no
 * symlinked ancestor, and the leaf is a regular file. `relPath` is
 * `changelog.d/<name>.md`. A missing fragment is a refusal (1): the release
 * captured it a moment ago, so it vanished mid-run.
 */
export function guardFragmentReadSafety(
  projectRoot: string,
  relPath: string,
): ChangelogSafetyResult {
  const fragmentPath = join(projectRoot, ...relPath.split("/"));
  const floor = symlinkAncestorFloor(projectRoot, fragmentPath);
  if (!floor.ok) return floor;
  let stats: BigIntStats;
  try {
    stats = lstatSync(fragmentPath, { bigint: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return safetyFail(EXIT_VIOLATION, "unsafe", `${relPath}: ${msg}`);
  }
  const kind = classifyReleaseLeaf(stats);
  if (kind !== null) {
    return safetyFail(EXIT_VIOLATION, kind, leafRefusalMessage(relPath, kind));
  }
  return { ok: true };
}
