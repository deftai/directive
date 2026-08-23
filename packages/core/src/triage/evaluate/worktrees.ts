import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  type GitRunner as SwarmGitRunner,
  defaultGitRunner as swarmGitRunner,
} from "../../swarm/worktrees.js";
import { evaluatorWorktreePath } from "./paths.js";
import type { GitRunner } from "./types.js";

export class EvaluatorWorktreeError extends Error {
  override name = "EvaluatorWorktreeError";
}

function toSwarm(git: GitRunner): SwarmGitRunner {
  return (args, cwd) => git(args, cwd);
}

export function addEvaluatorWorktree(
  projectRoot: string,
  issue: number,
  invocationId: string,
  originSha: string,
  git: GitRunner = swarmGitRunner,
): string {
  const sha = originSha.trim();
  if (sha.length === 0) {
    throw new EvaluatorWorktreeError("originSha is required for a detached evaluator worktree");
  }
  const worktreePath = evaluatorWorktreePath(projectRoot, issue, invocationId);
  mkdirSync(dirname(resolve(worktreePath)), { recursive: true });
  const proc = toSwarm(git)(["worktree", "add", "--detach", worktreePath, sha], projectRoot);
  if (proc.returncode !== 0) {
    throw new EvaluatorWorktreeError(
      `git worktree add --detach failed for issue ${issue}: ${proc.stderr.trim() || "<no stderr>"}`,
    );
  }
  return worktreePath;
}

function forceDeleteWorktreeDir(worktreePath: string): void {
  if (!existsSync(worktreePath)) {
    return;
  }
  rmSync(worktreePath, { recursive: true, force: true });
}

/** Verb-owned remove. Not a shared core git-worktree helper. */
export function removeEvaluatorWorktree(
  projectRoot: string,
  worktreePath: string,
  git: GitRunner = swarmGitRunner,
): void {
  const runner = toSwarm(git);
  const proc = runner(["worktree", "remove", "--force", worktreePath], projectRoot);
  if (proc.returncode === 0) {
    return;
  }
  const firstError = proc.stderr.trim() || "<no stderr>";
  forceDeleteWorktreeDir(worktreePath);
  runner(["worktree", "prune"], projectRoot);
  const retry = runner(["worktree", "remove", "--force", worktreePath], projectRoot);
  if (retry.returncode === 0 || !existsSync(worktreePath)) {
    return;
  }
  throw new EvaluatorWorktreeError(
    `git worktree remove failed for ${worktreePath}: ${firstError}; fallback: ${retry.stderr.trim() || "<no stderr>"}`,
  );
}
