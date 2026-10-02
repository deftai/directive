/**
 * Working-tree vs PR-head assert for closeout (#3875).
 *
 * Before closeout reads briefs from disk, the tree must be the PR head that
 * merges. Local HEAD is compared to an already-fetched PR head SHA (or an
 * injected forge blob SHA). Mismatch is exit 2 — never a silent wrong-tree read.
 *
 * When the caller's cwd is not the PR head (cascade from primary), a linked
 * worktree whose HEAD matches the PR head is accepted and returned as
 * `resolvedProjectRoot` so briefs are read from that tree. Dirty `xbrief/` /
 * `vbrief/` on the chosen tree fails closed (local attestation must not
 * green-light an unattested committed brief).
 */

import { spawnSync } from "node:child_process";
import type { RunGhFn } from "../pr-protected-issues/types.js";

export type ResolveLocalHeadShaFn = (projectRoot: string) => string | null;

export type FetchPrHeadShaFn = (prNumber: number, repo: string, runGh: RunGhFn) => string | null;

export type ResolveWorktreeAtShaFn = (projectRoot: string, sha: string) => string | null;

export type ResolveLifecycleDirtyFn = (projectRoot: string) => string | null;

export interface PrHeadAssertOptions {
  /** When false, skip the assert (tests only). Production default is enabled. */
  readonly enabled?: boolean;
  /** Injected local HEAD; when set, skips `git rev-parse`. */
  readonly localHeadSha?: string | null;
  /** Injected PR head SHA; when set, skips the forge read. */
  readonly prHeadSha?: string | null;
  readonly resolveLocalHeadSha?: ResolveLocalHeadShaFn;
  readonly fetchPrHeadSha?: FetchPrHeadShaFn;
  /** Injected linked-worktree lookup (cascade from a non-PR-head cwd). */
  readonly resolveWorktreeAtSha?: ResolveWorktreeAtShaFn;
  /** Injected dirty-lifecycle probe; when set, skips `git status --porcelain`. */
  readonly resolveLifecycleDirty?: ResolveLifecycleDirtyFn;
  /** When false, skip the dirty-lifecycle refuse (tests only). */
  readonly checkLifecycleDirty?: boolean;
}

export interface PrHeadAssertOk {
  readonly ok: true;
  readonly localHeadSha: string;
  readonly prHeadSha: string;
  /**
   * When the caller's tree was not the PR head but a linked worktree was,
   * evaluate MUST read briefs from this path.
   */
  readonly resolvedProjectRoot?: string;
}

export interface PrHeadAssertFail {
  readonly ok: false;
  readonly message: string;
}

export type PrHeadAssertResult = PrHeadAssertOk | PrHeadAssertFail;

/** Git short-SHA floor (same 7 as /^[0-9a-f]{7,40}$/i); length-derived, not a numeric const. */
const MIN_SHA_PREFIX = "xxxxxxx".length;

/** True when full or abbreviated SHAs name the same commit (min prefix length). */
export function shasMatch(a: string, b: string): boolean {
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  if (left.length < MIN_SHA_PREFIX || right.length < MIN_SHA_PREFIX) {
    return false;
  }
  return left.startsWith(right) || right.startsWith(left);
}

/** `git rev-parse HEAD` in `projectRoot`; null when git is missing or fails. */
export function resolveLocalHeadSha(projectRoot: string): string | null {
  const result = spawnSync("git", ["-C", projectRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error !== undefined || (result.status ?? 1) !== 0) {
    return null;
  }
  const sha = (typeof result.stdout === "string" ? result.stdout : "").trim();
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
}

/**
 * First linked worktree (same common dir) whose HEAD matches `sha`.
 * Used when cascade/`pr:merge-ready` runs from primary but a dest worktree
 * already holds the PR head.
 */
export function findWorktreeAtSha(projectRoot: string, sha: string): string | null {
  const result = spawnSync("git", ["-C", projectRoot, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error !== undefined || (result.status ?? 1) !== 0) {
    return null;
  }
  const text = typeof result.stdout === "string" ? result.stdout : "";
  let currentPath: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length).trim();
      continue;
    }
    if (line.startsWith("HEAD ") && currentPath !== null) {
      const head = line.slice("HEAD ".length).trim();
      if (shasMatch(head, sha)) {
        return currentPath;
      }
      currentPath = null;
    }
  }
  return null;
}

/**
 * Non-null when `xbrief/` or `vbrief/` has uncommitted changes under `projectRoot`.
 * Returns a short porcelain sample for the refusal message.
 */
export function resolveLifecycleDirty(projectRoot: string): string | null {
  const result = spawnSync(
    "git",
    ["-C", projectRoot, "status", "--porcelain", "--", "xbrief", "vbrief"],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (result.error !== undefined || (result.status ?? 1) !== 0) {
    return "cannot read git status for xbrief/vbrief before closeout";
  }
  const text = (typeof result.stdout === "string" ? result.stdout : "").trim();
  if (text.length === 0) {
    return null;
  }
  const sample = text
    .split(/\r?\n/)
    .slice(0, 3)
    .map((line) => line.trim())
    .join("; ");
  return sample;
}

/** REST `pulls/<N>` head.sha via the closeout runner (plain gh when available). */
export function fetchPrHeadShaViaApi(
  prNumber: number,
  repo: string,
  runGh: RunGhFn,
): string | null {
  const rc = runGh(["gh", "api", `repos/${repo}/pulls/${prNumber}`]);
  if (rc.returncode !== 0) {
    return null;
  }
  const raw = rc.stdout.trim();
  if (raw.length === 0) {
    return null;
  }
  try {
    const payload = JSON.parse(raw) as unknown;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }
    const head = (payload as Record<string, unknown>).head;
    if (head === null || typeof head !== "object" || Array.isArray(head)) {
      return null;
    }
    const sha = (head as Record<string, unknown>).sha;
    return typeof sha === "string" && /^[0-9a-f]{7,40}$/i.test(sha.trim()) ? sha.trim() : null;
  } catch {
    return null;
  }
}

function refuseDirtyLifecycle(projectRoot: string, dirtySample: string): PrHeadAssertFail {
  return {
    ok: false,
    message:
      `lifecycle tree under ${projectRoot} has uncommitted xbrief/vbrief changes ` +
      `(${dirtySample}). Closeout reads the committed PR-head brief — commit, ` +
      "stash, or discard local lifecycle edits and retry.",
  };
}

/**
 * Assert local HEAD equals the PR head that will merge.
 * Fail closed (message for exit 2) when either side is unreadable or they differ
 * and no linked worktree matches. Refuse a dirty lifecycle tree on the chosen root.
 */
export function assertWorkingTreeIsPrHead(
  projectRoot: string,
  prNumber: number,
  repo: string,
  runGh: RunGhFn,
  options: PrHeadAssertOptions = {},
): PrHeadAssertResult {
  if (options.enabled === false) {
    return { ok: true, localHeadSha: "", prHeadSha: "" };
  }

  const resolveLocal = options.resolveLocalHeadSha ?? resolveLocalHeadSha;
  const fetchPrHead = options.fetchPrHeadSha ?? fetchPrHeadShaViaApi;
  const resolveWorktree = options.resolveWorktreeAtSha ?? findWorktreeAtSha;
  const resolveDirty = options.resolveLifecycleDirty ?? resolveLifecycleDirty;
  // Hermetic tests inject SHAs and have no real git tree — skip dirty unless
  // they opt in (`checkLifecycleDirty: true` or inject `resolveLifecycleDirty`).
  const checkDirty =
    options.checkLifecycleDirty === true ||
    (options.checkLifecycleDirty !== false &&
      (options.resolveLifecycleDirty !== undefined ||
        (options.localHeadSha === undefined && options.prHeadSha === undefined)));

  const localHead =
    options.localHeadSha !== undefined ? options.localHeadSha : resolveLocal(projectRoot);
  if (localHead === null || localHead.trim().length === 0) {
    return {
      ok: false,
      message:
        `cannot resolve local HEAD in ${projectRoot} before reading closeout briefs. ` +
        "Run from the PR head checkout (or a worktree at that SHA).",
    };
  }

  const prHead =
    options.prHeadSha !== undefined ? options.prHeadSha : fetchPrHead(prNumber, repo, runGh);
  if (prHead === null || prHead.trim().length === 0) {
    return {
      ok: false,
      message:
        `cannot read PR #${prNumber} head SHA (repo=${repo}) before closeout. ` +
        "Refusing to certify briefs on an unverified tree — retry after fixing gh auth or network.",
    };
  }

  let effectiveRoot = projectRoot;
  let effectiveLocal = localHead.trim();
  let resolvedProjectRoot: string | undefined;

  if (!shasMatch(localHead, prHead)) {
    const alt = resolveWorktree(projectRoot, prHead.trim());
    if (alt === null || alt.trim().length === 0) {
      return {
        ok: false,
        message:
          `working tree HEAD ${localHead} is not PR #${prNumber} head ${prHead}. ` +
          "Closeout reads the tree that merges — check out the PR head (or pass " +
          "--project-root to its worktree) and retry.",
      };
    }
    const altHead = resolveLocal(alt);
    if (altHead === null || !shasMatch(altHead, prHead)) {
      return {
        ok: false,
        message:
          `linked worktree ${alt} did not resolve to PR #${prNumber} head ${prHead}. ` +
          "Pass --project-root to a checkout at that SHA and retry.",
      };
    }
    effectiveRoot = alt;
    effectiveLocal = altHead.trim();
    resolvedProjectRoot = alt;
  }

  if (checkDirty) {
    const dirty = resolveDirty(effectiveRoot);
    if (dirty !== null) {
      return refuseDirtyLifecycle(effectiveRoot, dirty);
    }
  }

  return {
    ok: true,
    localHeadSha: effectiveLocal,
    prHeadSha: prHead.trim(),
    ...(resolvedProjectRoot !== undefined ? { resolvedProjectRoot } : {}),
  };
}
