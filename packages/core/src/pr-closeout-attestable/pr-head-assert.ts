/**
 * Working-tree vs PR-head assert for closeout (#3875 / #6128).
 *
 * Before closeout reads briefs from disk, the tree must be the PR head that
 * merges. Local HEAD is compared to an already-fetched PR head SHA (or an
 * injected forge blob SHA). Mismatch is exit 2 — never a silent wrong-tree read.
 *
 * When the caller's cwd is not the PR head (cascade from primary), a linked
 * worktree whose HEAD matches the PR head is accepted and returned as
 * `resolvedProjectRoot` so briefs are read from that tree. Prefer a
 * lifecycle-clean match when several SHA matches exist (#6128 Prefer-A). Dirty
 * `xbrief/` / `vbrief/` on the chosen tree fails closed with a named reason and
 * deletion-restorative remediation (local attestation must not green-light an
 * unattested committed brief).
 */

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { RunGhFn } from "../pr-protected-issues/types.js";

export type ResolveLocalHeadShaFn = (projectRoot: string) => string | null;

export type FetchPrHeadShaFn = (prNumber: number, repo: string, runGh: RunGhFn) => string | null;

/** One porcelain status entry with C-quoting undone. */
export interface LifecyclePorcelainEntry {
  readonly x: string;
  readonly y: string;
  readonly path: string;
}

/** Three-state lifecycle classifier for xbrief/vbrief (#6128 Prefer-A). */
export type LifecycleClassifyResult =
  | { readonly status: "clean" }
  | { readonly status: "dirty"; readonly entries: readonly LifecyclePorcelainEntry[] }
  | { readonly status: "unverifiable"; readonly diagnostic: string };

export type ClassifyLifecycleDirtyFn = (projectRoot: string) => LifecycleClassifyResult;

/** Linked-worktree lookup: verified found/absent, or unverified list failure. */
export type FindWorktreeAtShaResult =
  | {
      readonly status: "found";
      readonly path: string;
      /**
       * True when another SHA-matching worktree (besides `path`) has an xbrief
       * layout. Documented false default for two-arg injectors.
       */
      readonly anotherShaMatchHasXbrief?: boolean;
    }
  | { readonly status: "absent" }
  | { readonly status: "error"; readonly message: string };

export type ResolveWorktreeAtShaFn = (projectRoot: string, sha: string) => FindWorktreeAtShaResult;

/** Legacy dirty probe: null clean, sample dirty, sentinel unverifiable. */
export type ResolveLifecycleDirtyFn = (projectRoot: string) => string | null;

export type CloseoutRefuseReason = "lifecycle-dirty" | "brief-root-layout-missing";

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
  /**
   * Injected three-state lifecycle classifier (#6128). Replaces the former
   * `resolveLifecycleDirty` options seam at both in-scope call sites.
   */
  readonly classifyLifecycleDirty?: ClassifyLifecycleDirtyFn;
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
  /** One-poll terminal discriminant for wait-mergeable (#6128). */
  readonly reason?: CloseoutRefuseReason;
}

export type PrHeadAssertResult = PrHeadAssertOk | PrHeadAssertFail;

/** Behaviour-identical unverifiable sentinel for `resolveLifecycleDirty`. */
export const LIFECYCLE_STATUS_UNREADABLE =
  "cannot read git status for xbrief/vbrief before closeout";

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

/** Strip git porcelain C-style quoting so classifiers see real paths. */
function unquotePorcelainPath(path: string): string {
  if (path.length < 2 || path[0] !== '"' || path[path.length - 1] !== '"') {
    return path;
  }
  return path.slice(1, -1).replace(/\\([\\"ntr])/g, (_m, c: string) => {
    if (c === "n") return "\n";
    if (c === "t") return "\t";
    if (c === "r") return "\r";
    return c;
  });
}

/** Parse `git status --porcelain` lines into {x,y,path} with C-quoting undone. */
export function parseLifecyclePorcelainEntries(stdout: string): LifecyclePorcelainEntry[] {
  const entries: LifecyclePorcelainEntry[] = [];
  for (const raw of stdout.replace(/\r\n/g, "\n").split("\n")) {
    if (raw.length < 4) continue;
    const x = raw.slice(0, 1);
    const y = raw.slice(1, 2);
    const entry = raw.slice(3);
    if (entry.includes(" -> ")) {
      const renamed = entry.split(" -> ").pop();
      if (renamed !== undefined && renamed.length > 0) {
        entries.push({ x, y, path: unquotePorcelainPath(renamed) });
      }
    } else if (entry.length > 0) {
      entries.push({ x, y, path: unquotePorcelainPath(entry) });
    }
  }
  return entries;
}

function sampleFromEntries(entries: readonly LifecyclePorcelainEntry[]): string {
  return entries
    .slice(0, 3)
    .map((e) => `${e.x}${e.y} ${e.path}`.trim())
    .join("; ");
}

/**
 * Three-state classifier for lifecycle dirt under `xbrief/` / `vbrief/`.
 * Classification and pathspec derivation read `entries[]`; display samples are
 * derived at the refuse site only.
 */
export function classifyLifecycleDirty(projectRoot: string): LifecycleClassifyResult {
  const result = spawnSync(
    "git",
    ["-C", projectRoot, "status", "--porcelain", "--", "xbrief", "vbrief"],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (result.error !== undefined || (result.status ?? 1) !== 0) {
    return {
      status: "unverifiable",
      diagnostic: LIFECYCLE_STATUS_UNREADABLE,
    };
  }
  const text = typeof result.stdout === "string" ? result.stdout : "";
  const entries = parseLifecyclePorcelainEntries(text);
  if (entries.length === 0) {
    return { status: "clean" };
  }
  return { status: "dirty", entries };
}

/**
 * Behaviour-identical thin wrapper over {@link classifyLifecycleDirty}:
 * null for clean, three-entry join for dirty, unverifiable sentinel for
 * unverifiable — keeps semantic-green compiling without signature change.
 */
export function resolveLifecycleDirty(projectRoot: string): string | null {
  const classified = classifyLifecycleDirty(projectRoot);
  if (classified.status === "clean") {
    return null;
  }
  if (classified.status === "unverifiable") {
    return classified.diagnostic;
  }
  return sampleFromEntries(classified.entries);
}

function hasXbriefLayout(projectRoot: string): boolean {
  return existsSync(join(projectRoot, "xbrief"));
}

interface WorktreeListEntry {
  readonly path: string;
  readonly head: string | null;
  readonly prunable: boolean;
}

function parseWorktreePorcelainList(text: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let currentPath: string | null = null;
  let currentHead: string | null = null;
  let prunable = false;
  const flush = () => {
    if (currentPath !== null) {
      entries.push({ path: currentPath, head: currentHead, prunable });
    }
    currentPath = null;
    currentHead = null;
    prunable = false;
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      flush();
      currentPath = line.slice("worktree ".length).trim();
      continue;
    }
    if (line.startsWith("HEAD ") && currentPath !== null) {
      currentHead = line.slice("HEAD ".length).trim();
      continue;
    }
    if (line.startsWith("prunable") || line === "gone") {
      prunable = true;
    }
  }
  flush();
  return entries;
}

function resolvePathKey(p: string): string {
  try {
    const native = (realpathSync as { native?: (path: string) => string }).native;
    return native !== undefined ? native(p) : realpathSync(p);
  } catch {
    return p.replace(/\\/g, "/").toLowerCase();
  }
}

/**
 * Rank SHA-matching linked worktrees: one porcelain list read, path order,
 * prefer lifecycle-clean via optional third-parameter classifier (default real
 * three-state). `ResolveWorktreeAtShaFn` stays two-argument for injectors.
 * Excludes prunable/gone. All-dirty returns found with ranked-first non-clean
 * path (never absent). Carries `anotherShaMatchHasXbrief` on found.
 */
export function findWorktreeAtSha(
  projectRoot: string,
  sha: string,
  classify: ClassifyLifecycleDirtyFn = classifyLifecycleDirty,
): FindWorktreeAtShaResult {
  const result = spawnSync("git", ["-C", projectRoot, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error !== undefined || (result.status ?? 1) !== 0) {
    const detail =
      result.error !== undefined
        ? result.error.message
        : `git worktree list exited ${String(result.status ?? 1)}`;
    return {
      status: "error",
      message: `cannot list linked worktrees under ${projectRoot} (${detail})`,
    };
  }
  const text = typeof result.stdout === "string" ? result.stdout : "";
  const listed = parseWorktreePorcelainList(text);
  const shaMatches = listed
    .filter((e) => e.head !== null && shasMatch(e.head, sha) && !e.prunable && existsSync(e.path))
    .sort((a, b) => a.path.localeCompare(b.path));

  if (shaMatches.length === 0) {
    return { status: "absent" };
  }

  const withBrief = shaMatches.filter((e) => hasXbriefLayout(e.path));
  let firstClean: string | null = null;
  let firstNonClean: string | null = null;

  for (const match of shaMatches) {
    const classified = classify(match.path);
    if (classified.status === "clean") {
      if (firstClean === null) {
        firstClean = match.path;
      }
    } else if (firstNonClean === null) {
      firstNonClean = match.path;
    }
  }

  const selected = firstClean ?? firstNonClean;
  if (selected === null) {
    return { status: "absent" };
  }

  const anotherShaMatchHasXbrief = withBrief.some((e) => {
    try {
      return resolvePathKey(e.path) !== resolvePathKey(selected);
    } catch {
      return e.path !== selected;
    }
  });

  return {
    status: "found",
    path: selected,
    anotherShaMatchHasXbrief,
  };
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

function isUntrackedEntry(entry: LifecyclePorcelainEntry): boolean {
  return entry.x === "?" || entry.y === "?";
}

function isTrackedModifyAddRename(entry: LifecyclePorcelainEntry): boolean {
  if (isUntrackedEntry(entry)) return false;
  return /[MAR]/.test(entry.x) || /[MAR]/.test(entry.y);
}

/** Pure tracked deletion (D) with no M/A/R on either side — excludes MD/DM (#6137 Greptile P1). */
function isRestorableDeletion(entry: LifecyclePorcelainEntry): boolean {
  if (isUntrackedEntry(entry)) return false;
  if (!(entry.x === "D" || entry.y === "D")) return false;
  return !isTrackedModifyAddRename(entry);
}

function shellSingleQuote(arg: string): string {
  return "'" + arg.replace(/'/g, "'\''") + "'";
}

/**
 * Deletion-restorative remediation buckets (#6128 Prefer-A Recut-8 errata).
 * Tracked codes only; never emit `git stash push -u`.
 * Deletions-only template: git -C "<dirty-root>" checkout HEAD -- <deleted-paths>
 * (Approach1 sole-pin un-pin). Modify/add/rename never get a bare checkout.
 */
export function formatLifecycleDirtyRemediation(
  dirtyRoot: string,
  entries: readonly LifecyclePorcelainEntry[],
): string {
  const tracked = entries.filter((e) => !isUntrackedEntry(e));
  const deletions = tracked.filter(isRestorableDeletion);
  const modifies = tracked.filter(isTrackedModifyAddRename);

  if (tracked.length === 0) {
    return (
      `No tracked xbrief/vbrief dirt under ${dirtyRoot} (untracked-only). ` +
      "Commit and push, or discard local lifecycle edits, then retry. " +
      "Do not use git stash push -u as copy-paste remediation."
    );
  }

  if (modifies.length === 0 && deletions.length > 0) {
    const paths = deletions.map((e) => shellSingleQuote(e.path)).join(" ");
    return (
      `Deletions-only lifecycle dirt (Approach1 sole-pin un-pin). Restore with:\n` +
      `  git -C ${shellSingleQuote(dirtyRoot)} checkout HEAD -- ${paths}\n` +
      "Then retry closeout / wait-mergeable."
    );
  }

  if (deletions.length > 0 && modifies.length > 0) {
    const deletedPaths = deletions.map((e) => shellSingleQuote(e.path)).join(" ");
    const modifiedPaths = modifies.map((e) => e.path).join(", ");
    return (
      `Tracked modify/add/rename present (${modifiedPaths}); do not bare-checkout over those. ` +
      `Optional restore for deleted paths only:\n` +
      `  git -C ${shellSingleQuote(dirtyRoot)} checkout HEAD -- ${deletedPaths}\n` +
      `(excludes modified entries). Otherwise commit and push, or discard local lifecycle edits. ` +
      "Do not use unqualified stash."
    );
  }

  return (
    `Tracked modify/add/rename lifecycle dirt under ${dirtyRoot}. ` +
    "Do not bare-checkout HEAD over those paths. Commit and push, or discard local " +
    "lifecycle edits, then retry. Do not use unqualified stash."
  );
}

export function refuseDirtyLifecycle(
  projectRoot: string,
  classified: Extract<LifecycleClassifyResult, { status: "dirty" }>,
): PrHeadAssertFail {
  const sample = sampleFromEntries(classified.entries);
  const remediation = formatLifecycleDirtyRemediation(projectRoot, classified.entries);
  return {
    ok: false,
    reason: "lifecycle-dirty",
    message:
      `lifecycle tree under ${projectRoot} has uncommitted xbrief/vbrief changes ` +
      `(${sample}). Closeout reads the committed PR-head brief. ${remediation}`,
  };
}

function refuseUnverifiableLifecycle(projectRoot: string, diagnostic: string): PrHeadAssertFail {
  return {
    ok: false,
    message:
      `lifecycle tree under ${projectRoot} status is unverifiable (${diagnostic}). ` +
      "Closeout cannot certify briefs without a readable git status — fix git and retry. " +
      "No discard remediation is printed for unverifiable status reads.",
  };
}

/**
 * Assert local HEAD equals the PR head that will merge.
 * Fail closed (message for exit 2) when either side is unreadable or they differ
 * and no linked worktree matches. Prefer a lifecycle-clean SHA match; refuse a
 * dirty lifecycle tree on the chosen root with reason lifecycle-dirty.
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
  const classify = options.classifyLifecycleDirty ?? classifyLifecycleDirty;
  const resolveWorktree =
    options.resolveWorktreeAtSha ??
    ((root: string, sha: string) => findWorktreeAtSha(root, sha, classify));
  // Hermetic tests inject SHAs and have no real git tree — skip dirty unless
  // they opt in (`checkLifecycleDirty: true` or inject classifier).
  const checkDirty =
    options.checkLifecycleDirty === true ||
    (options.checkLifecycleDirty !== false &&
      (options.classifyLifecycleDirty !== undefined ||
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
  let candidateZeroNonClean: LifecycleClassifyResult | null = null;

  const atTip = shasMatch(localHead, prHead);

  if (atTip && checkDirty) {
    const localClass = classify(projectRoot);
    if (localClass.status === "clean") {
      return {
        ok: true,
        localHeadSha: effectiveLocal,
        prHeadSha: prHead.trim(),
      };
    }
    // Caller-at-tip dirty/unverifiable: still enumerate siblings (candidate zero).
    candidateZeroNonClean = localClass;
  }

  if (!atTip || candidateZeroNonClean !== null) {
    const lookup = resolveWorktree(projectRoot, prHead.trim());
    if (lookup.status === "error") {
      if (candidateZeroNonClean !== null) {
        // Candidate-zero dirty lookup degrades to dirty/unverifiable refuse.
        if (candidateZeroNonClean.status === "dirty") {
          return refuseDirtyLifecycle(projectRoot, candidateZeroNonClean);
        }
        return refuseUnverifiableLifecycle(
          projectRoot,
          candidateZeroNonClean.status === "unverifiable"
            ? candidateZeroNonClean.diagnostic
            : LIFECYCLE_STATUS_UNREADABLE,
        );
      }
      return {
        ok: false,
        message:
          `${lookup.message}. Refusing to certify briefs when the PR-head worktree lookup ` +
          "is unverified — fix git and retry.",
      };
    }
    if (lookup.status === "absent" || lookup.path.trim().length === 0) {
      if (candidateZeroNonClean !== null) {
        if (candidateZeroNonClean.status === "dirty") {
          return refuseDirtyLifecycle(projectRoot, candidateZeroNonClean);
        }
        return refuseUnverifiableLifecycle(
          projectRoot,
          candidateZeroNonClean.status === "unverifiable"
            ? candidateZeroNonClean.diagnostic
            : LIFECYCLE_STATUS_UNREADABLE,
        );
      }
      return {
        ok: false,
        message:
          `working tree HEAD ${localHead} is not PR #${prNumber} head ${prHead}. ` +
          "Closeout reads the tree that merges — check out the PR head (or pass " +
          "--project-root to its worktree) and retry.",
      };
    }
    const alt = lookup.path;
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
    if (resolvePathKey(alt) !== resolvePathKey(projectRoot)) {
      resolvedProjectRoot = alt;
    }
  }

  if (checkDirty) {
    // Selection probe advisory; refuse authoritative (post-selection three-state).
    const dirty = classify(effectiveRoot);
    if (dirty.status === "dirty") {
      return refuseDirtyLifecycle(effectiveRoot, dirty);
    }
    if (dirty.status === "unverifiable") {
      return refuseUnverifiableLifecycle(effectiveRoot, dirty.diagnostic);
    }
  }

  return {
    ok: true,
    localHeadSha: effectiveLocal,
    prHeadSha: prHead.trim(),
    ...(resolvedProjectRoot !== undefined ? { resolvedProjectRoot } : {}),
  };
}
