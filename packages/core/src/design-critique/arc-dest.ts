/**
 * Arc dest from origin/<default> after fetch (#4296).
 *
 * One dest per arc. Not a swarm worktree. Pin is origin/<default> tip, never
 * local HEAD. Against-implementation dest is the fetched PR head SHA.
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defaultGitRunner, type GitRunner, type GitRunResult } from "../session/git.js";
import { isLinkedWorktreePath } from "../session/main-worktree.js";

const DISPATCH_SHA_RE = /^[0-9a-f]{7,40}$/i;
const ORIGIN_DEFAULT_CANDIDATES = ["origin/HEAD", "origin/main", "origin/master"] as const;

function isHexPin(value: string): boolean {
  return DISPATCH_SHA_RE.test(value.trim());
}

export type ArcDestPinKind = "origin-default" | "against-implementation";

export interface EnsureArcDestInput {
  readonly repoRoot: string;
  readonly destPath: string;
  readonly git?: GitRunner;
  /** Fetched PR head SHA. When set, dest pins that SHA instead of origin/<default>. */
  readonly againstImplementationSha?: string;
}

export interface EnsureArcDestResult {
  readonly destPath: string;
  readonly dispatchSha: string;
  readonly originRef: string;
  readonly pinKind: ArcDestPinKind;
  readonly reused: boolean;
}

export class ArcDestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ArcDestError";
    this.code = code;
  }
}

function gitOrThrow(
  git: GitRunner,
  repoRoot: string,
  args: readonly string[],
  code: string,
  label: string,
): GitRunResult {
  const result = git(repoRoot, args);
  if (result.code !== 0) {
    throw new ArcDestError(
      code,
      `${label} failed (rc=${result.code}): ${result.stderr.trim() || "<no stderr>"}`,
    );
  }
  return result;
}

function firstHexSha(stdout: string): string | null {
  const token = stdout.trim().split(/\s+/)[0] ?? "";
  return isHexPin(token) ? token.toLowerCase() : null;
}

function resolveOriginDefaultTipAfterFetch(
  repoRoot: string,
  git: GitRunner,
): { originRef: string; sha: string } {
  for (const ref of ORIGIN_DEFAULT_CANDIDATES) {
    const parsed = git(repoRoot, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
    if (parsed.code !== 0) continue;
    const sha = firstHexSha(parsed.stdout);
    if (sha === null) continue;
    return { originRef: ref, sha };
  }
  throw new ArcDestError(
    "origin-default-missing",
    "could not resolve origin/<default> tip after fetch (tried origin/HEAD, origin/main, origin/master)",
  );
}

/**
 * Fetch origin, then resolve origin/<default> tip. Never returns local HEAD.
 */
export function resolveOriginDefaultTip(
  repoRoot: string,
  git: GitRunner = defaultGitRunner,
): { originRef: string; sha: string } {
  gitOrThrow(git, repoRoot, ["fetch", "origin"], "fetch-failed", "git fetch origin");
  return resolveOriginDefaultTipAfterFetch(repoRoot, git);
}

function resolvePin(
  repoRoot: string,
  git: GitRunner,
  againstImplementationSha: string | undefined,
): { originRef: string; sha: string; pinKind: ArcDestPinKind } {
  gitOrThrow(git, repoRoot, ["fetch", "origin"], "fetch-failed", "git fetch origin");
  const against = againstImplementationSha?.trim() ?? "";
  if (against.length > 0) {
    if (!isHexPin(against)) {
      throw new ArcDestError(
        "against-implementation-not-pin",
        "against-implementation dest must be a fetched PR head SHA, not a moving ref",
      );
    }
    const parsed = gitOrThrow(
      git,
      repoRoot,
      ["rev-parse", "--verify", "--end-of-options", `${against}^{commit}`],
      "against-implementation-unresolved",
      `git rev-parse ${against}`,
    );
    const sha = firstHexSha(parsed.stdout);
    if (sha === null) {
      throw new ArcDestError(
        "against-implementation-unresolved",
        `against-implementation SHA ${against} did not resolve to a commit after fetch`,
      );
    }
    return { originRef: sha, sha, pinKind: "against-implementation" };
  }
  return { ...resolveOriginDefaultTipAfterFetch(repoRoot, git), pinKind: "origin-default" };
}

function destHeadSha(destPath: string, git: GitRunner): string | null {
  const parsed = git(destPath, ["rev-parse", "--verify", "HEAD"]);
  if (parsed.code !== 0) return null;
  return firstHexSha(parsed.stdout);
}

/**
 * Create or verify one arc dest at the fetched pin. Reuse only when HEAD matches
 * that tip after fetch. Never pins local HEAD.
 */
export function ensureArcDest(input: EnsureArcDestInput): EnsureArcDestResult {
  const repoRoot = resolve(input.repoRoot);
  const destPath = resolve(input.destPath);
  const git = input.git ?? defaultGitRunner;
  const pin = resolvePin(repoRoot, git, input.againstImplementationSha);

  if (existsSync(destPath)) {
    if (!isLinkedWorktreePath(destPath)) {
      throw new ArcDestError(
        "dest-not-worktree",
        `arc dest ${destPath} exists and is not a linked worktree`,
      );
    }
    const head = destHeadSha(destPath, git);
    if (head === pin.sha) {
      return {
        destPath,
        dispatchSha: pin.sha,
        originRef: pin.originRef,
        pinKind: pin.pinKind,
        reused: true,
      };
    }
    gitOrThrow(
      git,
      destPath,
      ["checkout", "--detach", "--end-of-options", pin.sha],
      "dest-checkout-failed",
      `git checkout --detach ${pin.sha}`,
    );
    return {
      destPath,
      dispatchSha: pin.sha,
      originRef: pin.originRef,
      pinKind: pin.pinKind,
      reused: true,
    };
  }

  mkdirSync(dirname(destPath), { recursive: true });
  gitOrThrow(
    git,
    repoRoot,
    ["worktree", "add", "--detach", destPath, pin.sha],
    "worktree-add-failed",
    `git worktree add --detach ${destPath} ${pin.sha}`,
  );
  return {
    destPath,
    dispatchSha: pin.sha,
    originRef: pin.originRef,
    pinKind: pin.pinKind,
    reused: false,
  };
}
