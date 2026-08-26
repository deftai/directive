import { mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, resolve as pathResolve } from "node:path";
import {
  assertProjectionContained,
  ProjectionContainmentError,
} from "../fs/projection-containment.js";
import { C3_FIELDS } from "./constants.js";
import { runText, type TextCaptureResult } from "./subprocess.js";
import { ensureSubagentStatusDir } from "./subagent-status-dir.js";

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

export class WorktreePathEscapeError extends WorktreeMapError {
  override name = "WorktreePathEscapeError";
}

export class WorktreeRevisionMismatchError extends WorktreeMapError {
  override name = "WorktreeRevisionMismatchError";
}

export type GitRunner = (args: readonly string[], cwd: string) => TextCaptureResult;

export const defaultGitRunner: GitRunner = (args, cwd) => runText(["git", ...args], { cwd });

function resolvePath(raw: string, repoRoot: string): string {
  const candidate = isAbsolute(raw) ? raw : pathResolve(repoRoot, raw);
  return pathResolve(candidate);
}

function assertWorktreePathContained(repoRoot: string, worktreePath: string): void {
  try {
    assertProjectionContained(repoRoot, worktreePath);
  } catch (err) {
    if (err instanceof ProjectionContainmentError) {
      throw new WorktreePathEscapeError(
        `worktree_path must stay under the repository root: ${err.message}`,
      );
    }
    throw err;
  }
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

/** One `git worktree list --porcelain` record. `head` is the commit OID or null. */
export interface WorktreePorcelainEntry {
  readonly branch: string | null;
  readonly head: string | null;
}

/** Parse `git worktree list --porcelain` into `{compareKey: {branch, head}}`. */
export function parseWorktreePorcelain(text: string): Map<string, WorktreePorcelainEntry> {
  const registered = new Map<string, WorktreePorcelainEntry>();
  let currentPath: string | null = null;
  let currentBranch: string | null = null;
  let currentHead: string | null = null;

  const flush = (): void => {
    if (currentPath !== null) {
      registered.set(compareKey(currentPath), { branch: currentBranch, head: currentHead });
    }
  };

  for (const line of text.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      currentPath = pathResolve(line.slice("worktree ".length).trim());
      currentBranch = null;
      currentHead = null;
    } else if (line.startsWith("HEAD ")) {
      const oid = line.slice("HEAD ".length).trim().toLowerCase();
      currentHead = oid.length > 0 ? oid : null;
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      currentBranch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    }
  }
  flush();
  return registered;
}

function gitWorktreeList(repoRoot: string, git: GitRunner): Map<string, WorktreePorcelainEntry> {
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

function resolveCommitOid(repoRoot: string, revision: string, git: GitRunner): string {
  let proc: TextCaptureResult;
  try {
    proc = git(["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`], repoRoot);
  } catch (exc: unknown) {
    throw new WorktreeMapConfigError(
      `could not resolve base '${revision}' to a commit OID in ${repoRoot}: ${String(exc)}`,
    );
  }
  if (proc.returncode !== 0) {
    throw new WorktreeMapConfigError(
      `could not resolve base '${revision}' to a commit OID in ${repoRoot} ` +
        `(rc=${proc.returncode}): ${proc.stderr.trim() || "<no stderr>"}`,
    );
  }
  const oid = (proc.stdout.trim().split(/\s+/)[0] ?? "").toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(oid)) {
    throw new WorktreeMapConfigError(
      `git rev-parse for base '${revision}' did not return a commit OID: ${JSON.stringify(oid)}`,
    );
  }
  return oid;
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

/**
 * Resolve a story-to-worktree mapping into normalized C3 records (frozen contract).
 *
 * Registered paths are reused only when their porcelain HEAD OID matches the
 * requested base OID. That comparison is a snapshot at resolution time — not a
 * pin on the worker's start revision (`swarm:launch` emits a manifest and stops).
 */
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
    assertWorktreePathContained(root, worktreePath);
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
  const requestedOid = resolveCommitOid(root, trimmedBase, git);
  for (const entry of resolved) {
    const existing = registered.get(entry._key);
    if (existing !== undefined) {
      const actualOid = existing.head ?? "";
      if (actualOid !== requestedOid) {
        throw new WorktreeRevisionMismatchError(
          `registered worktree '${entry.worktree_path}' HEAD OID is ${actualOid || "(missing)"} ` +
            `but requested base '${trimmedBase}' resolves to ${requestedOid}; ` +
            `this is a snapshot check at resolution time, not a pin on the worker's start revision`,
        );
      }
      ensureSubagentStatusDir(entry._abs);
      continue;
    }
    if (!createMissing) {
      throw new MissingWorktreeError(
        `story '${entry.story_id}' maps to '${entry.worktree_path}' which is not a registered git worktree and create_missing is disabled`,
      );
    }
    createWorktree(root, entry._abs, trimmedBase, git);
    ensureSubagentStatusDir(entry._abs);
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
