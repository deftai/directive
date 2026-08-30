import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { containedRemove, containedWrite } from "../../fs/contained-write.js";
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

const caseInsensitiveDirCache = new Map<string, boolean>();

function slashResolve(path: string): string {
  return resolve(path).replace(/\\/g, "/");
}

function directoryIgnoresCase(dir: string): boolean {
  let existing = resolve(dir);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) {
      return process.platform === "win32";
    }
    existing = parent;
  }
  const cached = caseInsensitiveDirCache.get(existing);
  if (cached !== undefined) {
    return cached;
  }
  const tag = randomBytes(6).toString("hex");
  const lower = join(existing, `.deft-cs-${tag}a`);
  const upper = join(existing, `.deft-cs-${tag}A`);
  let ignores = false;
  let probed = false;
  try {
    containedWrite({
      root: existing,
      target: lower,
      data: "",
      mode: "create",
      mkdir: false,
      mutation: false,
    });
    ignores = existsSync(upper);
    probed = true;
  } catch {
    // Fail closed: do not fold unless the probe proved case-insensitivity.
  } finally {
    try {
      containedRemove({ root: existing, target: lower, mutation: false });
    } catch {
      // ignore
    }
    try {
      containedRemove({ root: existing, target: upper, mutation: false });
    } catch {
      // ignore
    }
  }
  if (probed) {
    caseInsensitiveDirCache.set(existing, ignores);
  }
  return ignores;
}

function canonicalizeWorktreePath(path: string): string {
  const resolved = slashResolve(path);
  let existing = "";
  if (existsSync(path)) {
    existing = path;
  } else if (existsSync(resolved)) {
    existing = resolved;
  }
  if (existing.length > 0) {
    try {
      return realpathSync.native(existing).replace(/\\/g, "/");
    } catch {
      // Path vanished between exists and realpath.
    }
  }
  const parent = dirname(resolved);
  const base = basename(resolved);
  let parentCanon = slashResolve(parent);
  try {
    if (existsSync(parent)) {
      parentCanon = realpathSync.native(parent).replace(/\\/g, "/");
    }
  } catch {
    // Keep slash-resolved parent.
  }
  const leaf = directoryIgnoresCase(parent) ? base.toLowerCase() : base;
  return `${parentCanon}/${leaf}`;
}

/**
 * Unregister one missing worktree by deleting only its `$GIT_DIR/worktrees/<id>`
 * admin directory. Containment root is that worktrees dir (the git common dir
 * may sit outside a linked-worktree projectRoot). `git worktree prune` has no
 * path argument and operates on every registration, including concurrent
 * agents' reflogs.
 *
 * Path identity uses on-disk realpath when the worktree exists, and otherwise
 * folds case only when the parent directory is case-insensitive. A case-sensitive
 * Windows directory can host two worktrees that differ only by case; those
 * must not share an admin entry.
 */
function pruneEvaluatorWorktreeAdmin(
  git: SwarmGitRunner,
  projectRoot: string,
  worktreePath: string,
): void {
  const common = git(["rev-parse", "--git-common-dir"], projectRoot);
  const trimmed = common.stdout.trim();
  if (common.returncode !== 0 || trimmed.length === 0) {
    return;
  }
  const commonDir = isAbsolute(trimmed) ? resolve(trimmed) : resolve(projectRoot, trimmed);
  const worktreesDir = join(commonDir, "worktrees");
  if (!existsSync(worktreesDir)) {
    return;
  }
  const needle = canonicalizeWorktreePath(worktreePath);
  let names: string[] = [];
  try {
    names = readdirSync(worktreesDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      continue;
    }
    const gitdirFile = join(worktreesDir, name, "gitdir");
    if (!existsSync(gitdirFile)) {
      continue;
    }
    let recorded = "";
    try {
      recorded = readFileSync(gitdirFile, "utf8").trim();
    } catch {
      continue;
    }
    const recordedWorktree = recorded.replace(/\\/g, "/").replace(/\/\.git$/u, "");
    if (canonicalizeWorktreePath(recordedWorktree) === needle) {
      containedRemove({
        root: resolve(worktreesDir),
        target: join(worktreesDir, name),
        recursive: true,
        mutation: false,
      });
      return;
    }
  }
}

function worktreeStillRegistered(
  git: SwarmGitRunner,
  projectRoot: string,
  worktreePath: string,
): boolean {
  const listed = git(["worktree", "list", "--porcelain"], projectRoot);
  if (listed.returncode !== 0) {
    return true;
  }
  const needle = canonicalizeWorktreePath(worktreePath);
  for (const line of listed.stdout.split(/\r?\n/u)) {
    if (!line.startsWith("worktree ")) {
      continue;
    }
    const listedPath = canonicalizeWorktreePath(line.slice("worktree ".length));
    if (listedPath === needle) {
      return true;
    }
  }
  return false;
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
  pruneEvaluatorWorktreeAdmin(runner, projectRoot, worktreePath);
  const retry = runner(["worktree", "remove", "--force", worktreePath], projectRoot);
  if (retry.returncode === 0) {
    return;
  }
  forceDeleteWorktreeDir(worktreePath);
  pruneEvaluatorWorktreeAdmin(runner, projectRoot, worktreePath);
  if (!worktreeStillRegistered(runner, projectRoot, worktreePath) && !existsSync(worktreePath)) {
    return;
  }
  throw new EvaluatorWorktreeError(
    `git worktree remove failed for ${worktreePath}: ${firstError}; fallback: ${retry.stderr.trim() || "<no stderr>"}`,
  );
}
