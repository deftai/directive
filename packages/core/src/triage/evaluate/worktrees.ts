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

const caseInsensitiveDirCache = new Map<string, boolean>();
/** Test-only: force probe result (undefined = live probe / cache). */
let caseInsensitiveDirOverride: boolean | undefined;

/** Test-only: seed the probe cache (stale-true regression). */
export function __testOnly_seedCaseInsensitiveDirCache(dir: string, ignores: boolean): void {
  caseInsensitiveDirCache.set(resolve(dir), ignores);
}

/** Test-only: force directoryIgnoresCase for sibling-gate / fold regressions. */
export function __testOnly_setDirectoryIgnoresCaseOverride(value: boolean | undefined): void {
  caseInsensitiveDirOverride = value;
}

/** Test-only: clear the probe cache between cases. */
export function __testOnly_clearCaseInsensitiveDirCache(): void {
  caseInsensitiveDirCache.clear();
  caseInsensitiveDirOverride = undefined;
}

function slashResolve(path: string): string {
  return resolve(path).replace(/\\/g, "/");
}

function directoryIgnoresCase(dir: string, options?: { readonly bypassCache?: boolean }): boolean {
  if (caseInsensitiveDirOverride !== undefined) {
    return caseInsensitiveDirOverride;
  }
  let existing = resolve(dir);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) {
      return process.platform === "win32";
    }
    existing = parent;
  }
  if (options?.bypassCache !== true) {
    const cached = caseInsensitiveDirCache.get(existing);
    if (cached !== undefined) {
      return cached;
    }
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
    // Cache false so a later prune safety check cannot inherit a stale true.
    ignores = false;
    probed = true;
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

/** True when paths name the same worktree, including case-fold only on case-insensitive dirs. */
function worktreePathsReferToSame(left: string, right: string): boolean {
  if (canonicalizeWorktreePath(left) !== canonicalizeWorktreePath(right)) {
    return false;
  }
  const leftBase = basename(left.replace(/\/\.git$/u, ""));
  const rightBase = basename(right.replace(/\/\.git$/u, ""));
  if (leftBase === rightBase) {
    return true;
  }
  if (leftBase.toLowerCase() !== rightBase.toLowerCase()) {
    // Distinct basenames even ignoring case → distinct worktrees.
    return false;
  }
  // Case-only basename difference: re-probe without cache so a stale true cannot
  // unregister a case-distinct sibling after a failed sensitivity probe.
  return directoryIgnoresCase(dirname(resolve(right)), { bypassCache: true });
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
  // Bypass cache: a stale true must not fold a missing leaf (#5519 / #5460 class).
  const leaf = directoryIgnoresCase(parent, { bypassCache: true }) ? base.toLowerCase() : base;
  return `${parentCanon}/${leaf}`;
}

type WorktreeAdminRegistration = {
  readonly adminName: string;
  readonly recordedWorktree: string;
  readonly recordedBase: string;
};

type SelectedWorktreeAdmin = {
  readonly worktreesDir: string;
  readonly adminName: string;
  readonly recordedWorktree: string;
};

function worktreeLeafBasename(path: string): string {
  return basename(path.replace(/\\/g, "/").replace(/\/\.git$/u, ""));
}

function listEvaluatorWorktreeAdmins(worktreesDir: string): WorktreeAdminRegistration[] {
  let names: string[] = [];
  try {
    names = readdirSync(worktreesDir);
  } catch {
    return [];
  }
  const out: WorktreeAdminRegistration[] = [];
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
    out.push({
      adminName: name,
      recordedWorktree,
      recordedBase: basename(recordedWorktree),
    });
  }
  return out;
}

function resolveWorktreesAdminDir(git: SwarmGitRunner, projectRoot: string): string | null {
  const common = git(["rev-parse", "--git-common-dir"], projectRoot);
  const trimmed = common.stdout.trim();
  if (common.returncode !== 0 || trimmed.length === 0) {
    return null;
  }
  const commonDir = isAbsolute(trimmed) ? resolve(trimmed) : resolve(projectRoot, trimmed);
  const worktreesDir = join(commonDir, "worktrees");
  if (!existsSync(worktreesDir)) {
    return null;
  }
  return worktreesDir;
}

/**
 * Select the intended admin registration once from the initial inventory.
 * Exact-basename among case-only peers wins; sole casing-drift on an
 * insensitive volume may fold-match. Ambiguous identity returns null
 * (fail closed). Selection is retained across both remove fallback passes
 * so a previously excluded sibling is never promoted (#5735).
 */
function selectEvaluatorWorktreeAdmin(
  git: SwarmGitRunner,
  projectRoot: string,
  worktreePath: string,
): SelectedWorktreeAdmin | null {
  const worktreesDir = resolveWorktreesAdminDir(git, projectRoot);
  if (worktreesDir === null) {
    return null;
  }
  const admins = listEvaluatorWorktreeAdmins(worktreesDir);
  if (admins.length === 0) {
    return null;
  }
  const targetBase = worktreeLeafBasename(worktreePath);
  const exact = admins.filter((entry) => entry.recordedBase === targetBase);
  if (exact.length === 1) {
    return {
      worktreesDir,
      adminName: exact[0].adminName,
      recordedWorktree: exact[0].recordedWorktree,
    };
  }
  if (exact.length > 1) {
    const matched = exact.filter((entry) =>
      worktreePathsReferToSame(entry.recordedWorktree, worktreePath),
    );
    if (matched.length === 1) {
      return {
        worktreesDir,
        adminName: matched[0].adminName,
        recordedWorktree: matched[0].recordedWorktree,
      };
    }
    return null;
  }
  const caseOnly = admins.filter(
    (entry) =>
      entry.recordedBase !== targetBase &&
      entry.recordedBase.toLowerCase() === targetBase.toLowerCase(),
  );
  if (caseOnly.length === 1 && directoryIgnoresCase(worktreesDir, { bypassCache: true })) {
    return {
      worktreesDir,
      adminName: caseOnly[0].adminName,
      recordedWorktree: caseOnly[0].recordedWorktree,
    };
  }
  if (caseOnly.length > 0) {
    // Case-only peers without a sole insensitive alias: never promote.
    return null;
  }
  const pathMatched = admins.filter((entry) =>
    worktreePathsReferToSame(entry.recordedWorktree, worktreePath),
  );
  if (pathMatched.length === 1) {
    return {
      worktreesDir,
      adminName: pathMatched[0].adminName,
      recordedWorktree: pathMatched[0].recordedWorktree,
    };
  }
  return null;
}

/**
 * Delete only the previously selected `$GIT_DIR/worktrees/<id>` admin
 * directory. Once that registration is gone, further cleanup is a no-op —
 * never re-decide from the remaining set (#5735). Containment root is the
 * worktrees admin dir (git common dir may sit outside a linked projectRoot).
 */
function pruneSelectedEvaluatorWorktreeAdmin(selected: SelectedWorktreeAdmin | null): void {
  if (selected === null) {
    return;
  }
  const target = join(selected.worktreesDir, selected.adminName);
  if (!existsSync(target)) {
    return;
  }
  containedRemove({
    root: resolve(selected.worktreesDir),
    target,
    recursive: true,
    mutation: false,
  });
}

function forceDeleteSelectedWorktreeDir(
  worktreePath: string,
  selected: SelectedWorktreeAdmin | null,
): void {
  if (!existsSync(worktreePath)) {
    return;
  }
  const parent = dirname(resolve(worktreePath));
  const targetBase = worktreeLeafBasename(worktreePath);
  let names: string[] = [];
  try {
    names = readdirSync(parent);
  } catch {
    return;
  }
  // Exact spelling must appear in parent readdir. If only a case-variant is
  // present, rmSync would hit a non-selected sibling under fold (#5735).
  if (!names.includes(targetBase)) {
    return;
  }
  if (selected !== null) {
    const selectedBase = worktreeLeafBasename(selected.recordedWorktree);
    if (targetBase !== selectedBase && targetBase.toLowerCase() === selectedBase.toLowerCase()) {
      return;
    }
  }
  rmSync(worktreePath, { recursive: true, force: true });
}

/** Issue git worktree remove only while the argv still names the selected registration. */
function gitRemoveNamesSelectedRegistration(
  worktreePath: string,
  selected: SelectedWorktreeAdmin | null,
): boolean {
  if (selected === null) {
    // No admin ownership established — still allow Git to attempt the exact path
    // when the leaf spelling exists; refuse when only a case-variant remains.
    if (!existsSync(worktreePath)) {
      const parent = dirname(resolve(worktreePath));
      const targetBase = worktreeLeafBasename(worktreePath);
      let names: string[] = [];
      try {
        names = readdirSync(parent);
      } catch {
        return false;
      }
      const caseVariants = names.filter(
        (name) => name !== targetBase && name.toLowerCase() === targetBase.toLowerCase(),
      );
      return caseVariants.length === 0;
    }
    return true;
  }
  const argvBase = worktreeLeafBasename(worktreePath);
  const selectedBase = worktreeLeafBasename(selected.recordedWorktree);
  if (argvBase === selectedBase) {
    return true;
  }
  // Target spelling missing and only a case-variant sibling remains → do not remove.
  if (!existsSync(worktreePath) && argvBase.toLowerCase() === selectedBase.toLowerCase()) {
    return false;
  }
  return worktreePathsReferToSame(worktreePath, selected.recordedWorktree);
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
  // Operation-scoped ownership: select once before any destructive work (#5735).
  const selected = selectEvaluatorWorktreeAdmin(runner, projectRoot, worktreePath);

  let firstError = "<no stderr>";
  if (gitRemoveNamesSelectedRegistration(worktreePath, selected)) {
    const proc = runner(["worktree", "remove", "--force", worktreePath], projectRoot);
    if (proc.returncode === 0) {
      return;
    }
    firstError = proc.stderr.trim() || "<no stderr>";
  }

  forceDeleteSelectedWorktreeDir(worktreePath, selected);
  pruneSelectedEvaluatorWorktreeAdmin(selected);

  let retryError = "<no stderr>";
  let retryAttempted = false;
  if (gitRemoveNamesSelectedRegistration(worktreePath, selected)) {
    retryAttempted = true;
    const retry = runner(["worktree", "remove", "--force", worktreePath], projectRoot);
    if (retry.returncode === 0) {
      return;
    }
    retryError = retry.stderr.trim() || "<no stderr>";
  }

  forceDeleteSelectedWorktreeDir(worktreePath, selected);
  pruneSelectedEvaluatorWorktreeAdmin(selected);
  if (!worktreeStillRegistered(runner, projectRoot, worktreePath) && !existsSync(worktreePath)) {
    return;
  }
  throw new EvaluatorWorktreeError(
    `git worktree remove failed for ${worktreePath}: ${firstError}; fallback: ${
      retryAttempted ? retryError : "skipped (selected registration absent or ambiguous)"
    }`,
  );
}
