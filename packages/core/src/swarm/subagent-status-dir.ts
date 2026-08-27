/**
 * Arm the shipped sub-agent heartbeat path (#3730 / #1365 / #2824).
 *
 * `verify:subagent-alive` exits 2 when the scratch directory is missing, which
 * looks like "never started" instead of REDISPATCH_OK. Parents mkdir at
 * worktree create and at pre-dispatch begin so a later missing record is
 * exit 1. Does not write heartbeat records or liveness onto the C2 manifest.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { defaultScratchDir } from "../orchestration/subagent-monitor.js";

/**
 * True when a resolved path is an on-disk git worktree, i.e. it carries a `.git`
 * entry (a file for `git worktree add` trees, a directory for the main clone).
 *
 * Arming cannot key off `looksLikeFilesystemTarget` alone: that predicate exists
 * to keep branch refs opaque and so answers false for a bare relative worktree
 * name like `b3730`, leaving the liveness gate at its exit-2 config error for a
 * supported dispatch form. Existence alone is too loose in the other direction —
 * a branch named `docs` resolves onto the real `docs/` tree and would mkdir a
 * stray scratch dir in the source checkout. The `.git` marker separates the two.
 */
export function looksLikeWorktreeDir(resolvedPath: string): boolean {
  const trimmed = resolvedPath.trim();
  if (trimmed.length === 0) return false;
  return existsSync(join(trimmed, ".git"));
}

/**
 * Create `<worktree>/.deft-scratch/subagent-status/` when the worktree exists.
 * Returns the directory path, or null when the worktree is not on disk yet
 * (do not mkdir a stray tree for a branch-name target).
 */
export function ensureSubagentStatusDir(worktreeRoot: string): string | null {
  const trimmed = worktreeRoot.trim();
  if (trimmed.length === 0 || !existsSync(trimmed)) return null;
  const dir = defaultScratchDir(trimmed);
  mkdirSync(dir, { recursive: true });
  return dir;
}
