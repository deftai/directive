import { mkdirSync, readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { C3_FIELDS } from "./constants.js";
import { runText, type TextCaptureResult } from "./subprocess.js";

export class WorktreeMapError extends Error {
  override name = "WorktreeMapError";
}

export class WorktreeCollisionError extends WorktreeMapError {
  override name = "WorktreeCollisionError";
}

export class BaseBranchMismatchError extends WorktreeMapError {
  override name = "BaseBranchMismatchError";
}

export class MissingWorktreeError extends WorktreeMapError {
  override name = "MissingWorktreeError";
}

export class DuplicateStoryError extends WorktreeMapError {
  override name = "DuplicateStoryError";
}

export class WorktreeMapConfigError extends Error {
  override name = "WorktreeMapConfigError";
}

export type GitRunner = (args: readonly string[], cwd: string) => TextCaptureResult;

export const defaultGitRunner: GitRunner = (args, cwd) => runText(["git", ...args], { cwd });

function resolvePath(raw: string, repoRoot: string): string {
  const candidate = raw.startsWith("/") ? raw : pathResolve(repoRoot, raw);
  return pathResolve(candidate);
}

/** Case-normalized comparison key for worktree-path equality. */
export function compareKey(pathStr: string): string {
  return pathStr.replace(/\\/g, "/").toLowerCase();
}

export interface WorktreeRecord {
  readonly story_id: string;
  readonly worktree_path: string;
  readonly base_branch: string;
}

/** Parse `git worktree list --porcelain` into `{compareKey: branch|null}`. */
export function parseWorktreePorcelain(text: string): Map<string, string | null> {
  const registered = new Map<string, string | null>();
  let currentPath: string | null = null;
  let currentBranch: string | null = null;

  const flush = (): void => {
    if (currentPath !== null) {
      registered.set(compareKey(currentPath), currentBranch);
    }
  };

  for (const line of text.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      currentPath = pathResolve(line.slice("worktree ".length).trim());
      currentBranch = null;
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      currentBranch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    }
  }
  flush();
  return registered;
}

function gitWorktreeList(repoRoot: string, git: GitRunner): Map<string, string | null> {
  let proc: TextCaptureResult;
  try {
    proc = git(["worktree", "list", "--porcelain"], repoRoot);
  } catch (exc: unknown) {
    throw new WorktreeMapConfigError(
      `could not run \`git worktree list\` in ${repoRoot}: ${String(exc)}`,
    );
  }
  if (proc.returncode !== 0) {
    throw new WorktreeMapConfigError(
      `\`git worktree list\` failed in ${repoRoot} (rc=${proc.returncode}): ` +
        `${proc.stderr.trim() || "<no stderr>"} -- is this a git work tree?`,
    );
  }
  return parseWorktreePorcelain(proc.stdout);
}

function createWorktree(
  repoRoot: string,
  worktreePath: string,
  baseBranch: string,
  git: GitRunner,
): void {
  mkdirSync(pathResolve(worktreePath, ".."), { recursive: true });
  let proc: TextCaptureResult;
  try {
    proc = git(["worktree", "add", "--detach", worktreePath, baseBranch], repoRoot);
  } catch (exc: unknown) {
    throw new WorktreeMapConfigError(
      `could not run \`git worktree add\` for ${worktreePath}: ${String(exc)}`,
    );
  }
  if (proc.returncode !== 0) {
    throw new WorktreeMapConfigError(
      `\`git worktree add --detach ${worktreePath} ${baseBranch}\` failed ` +
        `(rc=${proc.returncode}): ${proc.stderr.trim() || "<no stderr>"}`,
    );
  }
}

interface InternalRecord extends WorktreeRecord {
  readonly _key: string;
  readonly _abs: string;
}

/** Resolve a story-to-worktree mapping into normalized C3 records (frozen contract). */
export function resolveWorktreeMap(
  mapping: readonly Record<string, unknown>[],
  baseBranch: string,
  createMissing = true,
  options: { repoRoot?: string; git?: GitRunner } = {},
): WorktreeRecord[] {
  if (!Array.isArray(mapping)) {
    throw new WorktreeMapConfigError(
      `worktree map must be a list of records, got ${typeof mapping}`,
    );
  }
  const trimmedBase = baseBranch.trim();
  if (trimmedBase.length === 0) {
    throw new WorktreeMapConfigError("base_branch must be a non-empty string");
  }

  const root = pathResolve(options.repoRoot ?? process.cwd());
  const git = options.git ?? defaultGitRunner;

  const resolved: InternalRecord[] = [];
  const seenPaths = new Map<string, string>();
  const seenStoryIds = new Map<string, string>();

  for (let index = 0; index < mapping.length; index += 1) {
    const record = mapping[index];
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      throw new WorktreeMapConfigError(`record #${index} must be an object, got ${typeof record}`);
    }
    const storyIdRaw = record.story_id;
    if (typeof storyIdRaw !== "string" || storyIdRaw.trim().length === 0) {
      throw new WorktreeMapConfigError(`record #${index} is missing a non-empty 'story_id'`);
    }
    const storyId = storyIdRaw.trim();
    const rawPath = record.worktree_path;
    if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
      throw new WorktreeMapConfigError(
        `story ${JSON.stringify(storyId)} is missing a non-empty 'worktree_path'`,
      );
    }

    const recordBase = record.base_branch;
    if (recordBase !== undefined && recordBase !== null) {
      if (typeof recordBase !== "string" || recordBase.trim().length === 0) {
        throw new WorktreeMapConfigError(
          `story ${JSON.stringify(storyId)} has a non-string / blank 'base_branch'`,
        );
      }
      if (recordBase.trim() !== trimmedBase) {
        throw new BaseBranchMismatchError(
          `story '${storyId}' declares base_branch '${recordBase.trim()}' but the cohort base branch is '${trimmedBase}'`,
        );
      }
    }

    const worktreePath = resolvePath(rawPath.trim(), root);
    const key = compareKey(worktreePath);
    const posixPath = worktreePath.replace(/\\/g, "/");

    if (seenPaths.has(key)) {
      throw new WorktreeCollisionError(
        `worktree path collision: stories '${seenPaths.get(key)}' and '${storyId}' both map to '${posixPath}'`,
      );
    }
    if (seenStoryIds.has(storyId)) {
      throw new DuplicateStoryError(
        `duplicate story_id '${storyId}': mapped to both '${seenStoryIds.get(storyId)}' and '${posixPath}'`,
      );
    }
    seenPaths.set(key, storyId);
    seenStoryIds.set(storyId, posixPath);
    resolved.push({
      story_id: storyId,
      worktree_path: posixPath,
      base_branch: trimmedBase,
      _key: key,
      _abs: worktreePath,
    });
  }

  const registered = gitWorktreeList(root, git);
  for (const entry of resolved) {
    if (registered.has(entry._key)) {
      continue;
    }
    if (!createMissing) {
      throw new MissingWorktreeError(
        `story '${entry.story_id}' maps to '${entry.worktree_path}' which is not a registered git worktree and create_missing is disabled`,
      );
    }
    createWorktree(root, entry._abs, trimmedBase, git);
  }

  return resolved.map(({ story_id, worktree_path, base_branch }) => ({
    story_id,
    worktree_path,
    base_branch,
  }));
}

export function loadWorktreeMapFile(mapPath: string): Record<string, unknown>[] {
  let raw: string;
  try {
    raw = readFileSync(mapPath, "utf8");
  } catch (exc: unknown) {
    throw new WorktreeMapConfigError(`could not read worktree map ${mapPath}: ${String(exc)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch (exc: unknown) {
    const message = exc instanceof Error ? exc.message : String(exc);
    throw new WorktreeMapConfigError(`worktree map ${mapPath} is not valid JSON: ${message}`);
  }
  if (!Array.isArray(data)) {
    throw new WorktreeMapConfigError(
      `worktree map ${mapPath} top-level value must be a JSON array`,
    );
  }
  return data as Record<string, unknown>[];
}

export { C3_FIELDS };
