/**
 * Working-tree vs PR-head assert for closeout (#3875).
 *
 * Before closeout reads briefs from disk, the tree must be the PR head that
 * merges. Local HEAD is compared to an already-fetched PR head SHA (or an
 * injected forge blob SHA). Mismatch is exit 2 — never a silent wrong-tree read.
 */

import { spawnSync } from "node:child_process";
import type { RunGhFn } from "../pr-protected-issues/types.js";

export type ResolveLocalHeadShaFn = (projectRoot: string) => string | null;

export type FetchPrHeadShaFn = (prNumber: number, repo: string, runGh: RunGhFn) => string | null;

export interface PrHeadAssertOptions {
  /** When false, skip the assert (tests only). Production default is enabled. */
  readonly enabled?: boolean;
  /** Injected local HEAD; when set, skips `git rev-parse`. */
  readonly localHeadSha?: string | null;
  /** Injected PR head SHA; when set, skips the forge read. */
  readonly prHeadSha?: string | null;
  readonly resolveLocalHeadSha?: ResolveLocalHeadShaFn;
  readonly fetchPrHeadSha?: FetchPrHeadShaFn;
}

export interface PrHeadAssertOk {
  readonly ok: true;
  readonly localHeadSha: string;
  readonly prHeadSha: string;
}

export interface PrHeadAssertFail {
  readonly ok: false;
  readonly message: string;
}

export type PrHeadAssertResult = PrHeadAssertOk | PrHeadAssertFail;

/** True when full or abbreviated SHAs name the same commit. */
export function shasMatch(a: string, b: string): boolean {
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  if (left.length === 0 || right.length === 0) {
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

/**
 * Assert local HEAD equals the PR head that will merge.
 * Fail closed (message for exit 2) when either side is unreadable or they differ.
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

  if (!shasMatch(localHead, prHead)) {
    return {
      ok: false,
      message:
        `working tree HEAD ${localHead} is not PR #${prNumber} head ${prHead}. ` +
        "Closeout reads the tree that merges — check out the PR head (or its worktree) and retry.",
    };
  }

  return { ok: true, localHeadSha: localHead.trim(), prHeadSha: prHead.trim() };
}
