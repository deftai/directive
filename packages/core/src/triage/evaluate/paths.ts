import { join, resolve } from "node:path";
import { SHA12_LENGTH } from "./types.js";

export function sha12Of(fullSha: string): string {
  const trimmed = fullSha.trim().toLowerCase();
  if (!/^[0-9a-f]{12,40}$/u.test(trimmed)) {
    throw new Error(`origin/master SHA is not a git object id: ${fullSha.trim()}`);
  }
  return trimmed.slice(0, SHA12_LENGTH);
}

export function issueEvalScratchRoot(projectRoot: string): string {
  return join(resolve(projectRoot), ".deft-scratch", "issue-eval");
}

export function sinkDir(projectRoot: string, sha12: string, invocationId: string): string {
  return join(issueEvalScratchRoot(projectRoot), sha12, invocationId);
}

export function sinkVerdictPath(
  projectRoot: string,
  sha12: string,
  invocationId: string,
  issue: number,
): string {
  return join(sinkDir(projectRoot, sha12, invocationId), `issue-${issue}.json`);
}

export function sinkManifestPath(projectRoot: string, sha12: string, invocationId: string): string {
  return join(sinkDir(projectRoot, sha12, invocationId), "manifest.json");
}

export function evaluatorWorktreePath(
  projectRoot: string,
  issue: number,
  invocationId: string,
): string {
  return join(
    resolve(projectRoot),
    ".deft-scratch",
    "worktrees",
    `issue-eval-${issue}-${invocationId}`,
  ).replace(/\\/g, "/");
}
