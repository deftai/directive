/**
 * Checkout hygiene warning on `scope:complete` (#5988).
 *
 * Warn only: the lines go to stderr after a successful completion move, and
 * nothing here refuses, changes an exit code, or cleans anything up. The
 * worktree count is the same live linked-checkout list the primary-checkout
 * write checks walk (#5920), read from disk with one git call for the common
 * dir. The branch count is one `git for-each-ref` over `refs/heads`. Each read
 * stands alone: a failed read omits only its own line.
 */

import { defaultGitRunner, type GitRunner } from "../session/git.js";
import { listLinkedWorktreeCheckouts } from "../session/main-worktree.js";

/**
 * Above this many live linked worktrees, the primary-checkout write checks get
 * slow enough to matter (#5920); the operator's threshold on #5988. Minted
 * intent constraint (25 linked worktrees, scope invocation).
 */
export const CHECKOUT_HYGIENE_MAX_LINKED_WORKTREES = 25;

/**
 * Above this many local branches, the clone carries branch clutter worth
 * pruning (#5988). Provisional; minted intent constraint (100 local branches,
 * scope invocation).
 */
export const CHECKOUT_HYGIENE_MAX_LOCAL_BRANCHES = 100;

/** Worktree line for `count` live linked worktrees, or null at or under the threshold. */
export function linkedWorktreeHygieneLine(count: number): string | null {
  if (count <= CHECKOUT_HYGIENE_MAX_LINKED_WORKTREES) return null;
  return (
    `checkout hygiene: ${count} linked worktrees (more than ${CHECKOUT_HYGIENE_MAX_LINKED_WORKTREES}). ` +
    "Directive's write checks on the primary checkout read every linked worktree, " +
    "so they slow down as the count grows (#5920). " +
    "Remove the ones you no longer need: git worktree remove <path>, then git worktree prune."
  );
}

/** Branch line for `count` local branches, or null at or under the threshold. */
export function localBranchHygieneLine(count: number): string | null {
  if (count <= CHECKOUT_HYGIENE_MAX_LOCAL_BRANCHES) return null;
  return (
    `checkout hygiene: ${count} local branches (more than ${CHECKOUT_HYGIENE_MAX_LOCAL_BRANCHES}). ` +
    "Old local branches clutter the clone. " +
    "Delete the merged ones you no longer need: git branch -d <name>."
  );
}

/** Local branch count from one for-each-ref run, or null when the read fails. */
function countLocalBranches(projectRoot: string, runGit: GitRunner): number | null {
  const result = runGit(projectRoot, ["for-each-ref", "--format=%(refname)", "refs/heads"]);
  if (result.code !== 0) return null;
  return result.stdout.split("\n").filter((line) => line.trim().length > 0).length;
}

/**
 * Zero, one or two hygiene lines for the clone that holds `projectRoot`.
 * Never throws; a failed read omits only its own line.
 */
export function checkoutHygieneWarningLines(
  projectRoot: string,
  runGit: GitRunner = defaultGitRunner,
): string[] {
  const lines: string[] = [];
  try {
    const line = linkedWorktreeHygieneLine(listLinkedWorktreeCheckouts(projectRoot, runGit).length);
    if (line !== null) lines.push(line);
  } catch {
    // Best-effort: a failed worktree read omits the worktree line only.
  }
  try {
    const count = countLocalBranches(projectRoot, runGit);
    const line = count === null ? null : localBranchHygieneLine(count);
    if (line !== null) lines.push(line);
  } catch {
    // Best-effort: a failed branch read omits the branch line only.
  }
  return lines;
}
