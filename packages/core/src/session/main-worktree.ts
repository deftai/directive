/**
 * Main-worktree discriminator (#4066).
 *
 * Occupancy keys on worktree path, not branch name. The contended checkout is
 * `dirname(git-common-dir)` -- the non-linked clone -- already used as MAIN in
 * swarm routing. A linked worktree has a `.git` *file*; the main clone has a
 * `.git` directory.
 */

import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defaultGitRunner, type GitRunner, gitCommonDir } from "./git.js";

function sameTree(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  if (process.platform === "win32") return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/** True when `projectRoot` is the non-linked clone (`dirname(git-common-dir)`). */
export function isMainWorktreePath(
  projectRoot: string,
  runGit: GitRunner = defaultGitRunner,
): boolean {
  const common = gitCommonDir(projectRoot, runGit);
  if (common === null) return false;
  return sameTree(dirname(common), projectRoot);
}

/** True when `projectRoot` is a linked worktree (`.git` is a file). */
export function isLinkedWorktreePath(projectRoot: string): boolean {
  const gitEntry = join(resolve(projectRoot), ".git");
  try {
    return existsSync(gitEntry) && statSync(gitEntry).isFile();
  } catch {
    return false;
  }
}

/** Main clone root, or null when git-common-dir cannot be read. */
export function mainWorktreeRoot(
  projectRoot: string,
  runGit: GitRunner = defaultGitRunner,
): string | null {
  const common = gitCommonDir(projectRoot, runGit);
  if (common === null) return null;
  return resolve(dirname(common));
}
