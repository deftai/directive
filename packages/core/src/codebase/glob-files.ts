import { execFileSync } from "node:child_process";
import { existsSync, globSync, type Stats, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { NON_PRODUCT_DIRS } from "../fs/non-product-dirs.js";

/**
 * Shared "not product source" core (#3487) plus `build`, which only the
 * codebase expander treats as non-source. Agent worktrees are not source
 * modules (#2953, #1656).
 */
export const SKIP_DIRS = new Set([...NON_PRODUCT_DIRS, "build"]);

export interface ModuleGlobExpansion {
  readonly files: readonly string[];
  readonly unmatched: readonly string[];
  readonly filesByGlob: ReadonlyMap<string, readonly string[]>;
}

function posixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function hasGitMetadata(start: string): boolean {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, ".git"))) {
      return true;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return false;
    }
    dir = parent;
  }
}

/**
 * Tracked files relative to `projectRoot`, or `null` when git is unavailable
 * so callers fall back to the working-tree glob walk.
 *
 * A `.git` worktree whose `git ls-files` fails returns `[]` (fail closed)
 * rather than `null`, so untracked files cannot satisfy a required glob.
 */
export function listTrackedFiles(projectRoot: string): string[] | null {
  try {
    const stdout = execFileSync("git", ["ls-files", "-z"], {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return stdout.split("\0").filter((line) => line.length > 0);
  } catch {
    if (hasGitMetadata(projectRoot)) {
      return [];
    }
    return null;
  }
}

function isSkippedRel(rel: string): boolean {
  return rel.split("/").some((part) => SKIP_DIRS.has(part));
}

function isFile(full: string): boolean {
  let st: Stats;
  try {
    st = statSync(full);
  } catch {
    return false;
  }
  return st.isFile();
}

/**
 * Expand authored pathGlobs with the same SKIP_DIRS policy the MAP extractor
 * uses. Prefer `git ls-files` (tracked truth); fall back to globSync when git
 * is missing. Default globSync is nodot, so `content/.agents` copies are not
 * matched unless a glob names that stem.
 */
export function expandModuleGlobs(
  projectRoot: string,
  globs: readonly string[],
): ModuleGlobExpansion {
  const tracked = listTrackedFiles(projectRoot);
  const trackedSet = tracked === null ? null : new Set(tracked);
  const filesByGlob = new Map<string, string[]>();
  const all = new Set<string>();
  const unmatched: string[] = [];

  for (const globValue of globs) {
    let matches: string[];
    try {
      matches = globSync(globValue, { cwd: projectRoot });
    } catch {
      matches = [];
    }
    const hits: string[] = [];
    for (const match of matches) {
      const rel = posixPath(match);
      if (trackedSet !== null && !trackedSet.has(rel)) {
        continue;
      }
      if (isSkippedRel(rel)) {
        continue;
      }
      if (!isFile(join(projectRoot, match))) {
        continue;
      }
      hits.push(rel);
      all.add(rel);
    }
    hits.sort((a, b) => a.localeCompare(b));
    filesByGlob.set(globValue, hits);
    if (hits.length === 0) {
      unmatched.push(globValue);
    }
  }

  return {
    files: [...all].sort((a, b) => a.localeCompare(b)),
    unmatched,
    filesByGlob,
  };
}

/** Absolute paths for extractor consumers that still join against projectRoot. */
export function globFiles(projectRoot: string, globs: readonly string[]): string[] {
  return expandModuleGlobs(projectRoot, globs).files.map((rel) => join(projectRoot, rel));
}
