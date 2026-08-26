/**
 * Arm the shipped sub-agent heartbeat path (#3730 / #1365 / #2824).
 *
 * `verify:subagent-alive` exits 2 when the scratch directory is missing, which
 * looks like "never started" instead of REDISPATCH_OK. Parents mkdir at
 * worktree create and at pre-dispatch begin so a later missing record is
 * exit 1. Does not write heartbeat records or liveness onto the C2 manifest.
 */

import { existsSync, mkdirSync } from "node:fs";
import { defaultScratchDir } from "../orchestration/subagent-monitor.js";

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
