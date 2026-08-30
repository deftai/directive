/**
 * Candidate diff ownership for the merge-chokepoint orphan run (#3893).
 *
 * The unscoped sweep enumerates every running brief under `active/`. Composed
 * on `check:merge` that gives one stranded brief merge authority over every
 * open PR, and N stranded briefs make N single-brief lifecycle PRs mutually
 * unmergeable — each leaves the other orphan. The pre-merge run cannot see the
 * residue its own candidate is about to create either: that candidate's linked
 * PR still reads `merged_at: null` while the gate runs.
 *
 * Scoping the merge run to the candidate's own diff removes the coupling
 * without touching the detector. Repo-wide truth stays enforced at the
 * delivery tip (HEAD on the delivery line falls back to the full sweep) and
 * after merge (`--issue N`, #3429).
 */

import { relative, resolve } from "node:path";
import { resolveDeliveryBranch } from "../policy/delivery-branch.js";
import { defaultGitRunner, type GitRunner } from "../session/git.js";

export type CandidateScope =
  | {
      readonly kind: "diff";
      /** Ref the candidate was diffed against (e.g. `origin/master`). */
      readonly baseRef: string;
      /** Absolute, platform-normalized brief paths this candidate owns. */
      readonly paths: ReadonlySet<string>;
    }
  | {
      readonly kind: "sweep";
      /** Why this run stayed repo-wide; always printed with the verdict. */
      readonly reason: string;
    };

export interface CandidateScopeOptions {
  /** Explicit base ref; defaults to `origin/<deliveryBranch>` then the branch. */
  readonly baseRef?: string | null;
  readonly runGit?: GitRunner;
}

/** Case-fold on win32 so a git path and a readdir path compare equal. */
export function normalizeScopePath(path: string): string {
  const abs = resolve(path);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

function sweep(reason: string): CandidateScope {
  return { kind: "sweep", reason };
}

function splitPaths(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function refExists(cwd: string, ref: string, runGit: GitRunner): boolean {
  return runGit(cwd, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]).code === 0;
}

/**
 * Base ref for the candidate diff: explicit override, else `origin/<branch>`,
 * else the local delivery branch. Null when none resolves.
 */
export function resolveCandidateBaseRef(
  projectRoot: string,
  override: string | null | undefined,
  runGit: GitRunner,
): string | null {
  const explicit = override?.trim() ?? "";
  if (explicit.length > 0) {
    return refExists(projectRoot, explicit, runGit) ? explicit : null;
  }
  const branch = resolveDeliveryBranch(projectRoot, runGit).branch;
  for (const candidate of [`origin/${branch}`, branch]) {
    if (refExists(projectRoot, candidate, runGit)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Brief paths under `activeDir` that the candidate's own diff touches.
 *
 * Falls back to the repo-wide sweep — never to a narrower scan — when git,
 * the base ref, or the diff is unavailable, so the flag cannot silently
 * shrink what a merge gate looks at.
 */
export function resolveCandidateScope(
  projectRoot: string,
  activeDir: string,
  options: CandidateScopeOptions = {},
): CandidateScope {
  const runGit = options.runGit ?? defaultGitRunner;
  const root = resolve(projectRoot);

  const topLevel = runGit(root, ["rev-parse", "--show-toplevel"]);
  if (topLevel.code !== 0) {
    return sweep("not a git worktree, so no candidate diff exists");
  }
  const gitRoot = topLevel.stdout.trim();
  if (gitRoot.length === 0) {
    return sweep("git worktree root could not be resolved");
  }

  const baseRef = resolveCandidateBaseRef(root, options.baseRef, runGit);
  if (baseRef === null) {
    const requested = options.baseRef?.trim() ?? "";
    return sweep(
      requested.length > 0
        ? `base ref '${requested}' not found; fetch it or pass a resolvable --base-ref`
        : "no delivery base ref found (no origin/<deliveryBranch> or local branch); fetch it or pass --base-ref",
    );
  }

  // HEAD at or behind the delivery line is the delivery tip itself, not a
  // candidate: keep repo-wide truth there.
  if (runGit(root, ["merge-base", "--is-ancestor", "HEAD", baseRef]).code === 0) {
    return sweep(`HEAD is on the ${baseRef} delivery line, so this run is the delivery-tip check`);
  }

  const mergeBase = runGit(root, ["merge-base", "HEAD", baseRef]);
  if (mergeBase.code !== 0) {
    return sweep(`could not compute the merge base with ${baseRef}`);
  }
  const base = mergeBase.stdout.trim();
  if (base.length === 0) {
    return sweep(`merge base with ${baseRef} is empty`);
  }

  const activeRel = relative(gitRoot, resolve(activeDir)).replace(/\\/g, "/");
  if (activeRel.length === 0 || activeRel.startsWith("..")) {
    return sweep("active/ is outside the git worktree");
  }

  // Diff against the working tree, not HEAD: a locally activated brief is a
  // pre-commit `task check` candidate too.
  const changed = runGit(gitRoot, ["diff", "--name-only", base, "--", activeRel]);
  if (changed.code !== 0) {
    return sweep(`could not diff active/ against ${baseRef}`);
  }
  const untracked = runGit(gitRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    activeRel,
  ]);
  if (untracked.code !== 0) {
    return sweep("could not list untracked briefs under active/");
  }

  const paths = new Set<string>();
  for (const rel of [...splitPaths(changed.stdout), ...splitPaths(untracked.stdout)]) {
    paths.add(normalizeScopePath(resolve(gitRoot, rel)));
  }
  return { kind: "diff", baseRef, paths };
}
