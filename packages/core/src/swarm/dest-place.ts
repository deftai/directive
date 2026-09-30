/**
 * Interactive Grok implement dest-place (#4575 Prefer-A).
 *
 * Creates a unique linked worktree with the same argv as createWorktree /
 * ensureArcDest (`git worktree add --detach <path> <commit-ish>`), then the
 * parent sets tool_input.cwd before spawn_subagent. Does not mint a
 * reservation — mintImplementSpawnReservation stays after consult allows.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as pathResolve } from "node:path";
import { reconstituteLinkedWorktreeDeposit } from "../init-deposit/gitignore.js";
import { isLinkedWorktreePath, mainWorktreeRoot } from "../session/main-worktree.js";
import { ensureSubagentStatusDir } from "./subagent-status-dir.js";
import type { TextCaptureResult } from "./subprocess.js";
import { defaultGitRunner, type GitRunner } from "./worktrees.js";

export type DestPlaceFailureCode =
  | "path-required"
  | "commit-ish-required"
  | "path-not-worktree"
  | "worktree-add-failed"
  | "deposit-refused"
  | "revision-mismatch"
  | "foreign-worktree";

export type DestPlaceResult =
  | {
      readonly ok: true;
      readonly worktreePath: string;
      readonly commitIsh: string;
      readonly created: boolean;
      /** Grok implement dest field after dest-place. */
      readonly cwd: string;
    }
  | {
      readonly ok: false;
      readonly code: DestPlaceFailureCode;
      readonly message: string;
    };

export interface DestPlaceImplementSpawnInput {
  readonly repoRoot: string;
  readonly worktreePath: string;
  readonly commitIsh: string;
  readonly git?: GitRunner;
}

function resolvePath(raw: string, repoRoot: string): string {
  const candidate = isAbsolute(raw) ? raw : pathResolve(repoRoot, raw);
  return pathResolve(candidate);
}

function safeSegment(text: string): string {
  let cleaned = "";
  for (const ch of text.trim()) {
    if (
      (ch >= "A" && ch <= "Z") ||
      (ch >= "a" && ch <= "z") ||
      (ch >= "0" && ch <= "9") ||
      ch === "-" ||
      ch === "_" ||
      ch === "."
    ) {
      cleaned += ch;
    } else {
      cleaned += "-";
    }
  }
  let start = 0;
  let end = cleaned.length;
  while (start < end && (cleaned[start] === "-" || cleaned[start] === ".")) {
    start += 1;
  }
  while (end > start && (cleaned[end - 1] === "-" || cleaned[end - 1] === ".")) {
    end -= 1;
  }
  cleaned = cleaned.slice(start, end);
  return cleaned.length > 0 ? cleaned : "spawn";
}

/**
 * Suggest a unique linked-worktree path under `.deft-scratch/worktrees/<leaf>`.
 * Parent must still call {@link destPlaceImplementSpawn} before spawn.
 */
export function suggestImplementSpawnDestPath(repoRoot: string, leafId: string): string {
  return join(pathResolve(repoRoot), ".deft-scratch", "worktrees", safeSegment(leafId)).replace(
    /\\/g,
    "/",
  );
}

/**
 * Dest-place a linked worktree for interactive Grok implement spawn.
 * Bare `--detach` (missing path or commit-ish) is refused. Does not mint
 * reservation or write child-occupancy.
 */
export function destPlaceImplementSpawn(input: DestPlaceImplementSpawnInput): DestPlaceResult {
  const repoRoot = pathResolve(input.repoRoot);
  const pathRaw = input.worktreePath.trim();
  const commitIsh = input.commitIsh.trim();
  if (pathRaw.length === 0) {
    return {
      ok: false,
      code: "path-required",
      message:
        "dest-place refused: worktree path is required. Bare `git worktree add --detach` " +
        "(no path) is not a recovery. Pass --detach <path> <commit-ish>.",
    };
  }
  if (commitIsh.length === 0) {
    return {
      ok: false,
      code: "commit-ish-required",
      message:
        "dest-place refused: commit-ish is required. Bare `git worktree add --detach` " +
        "(no path/commit) is not a recovery. Pass --detach <path> <commit-ish>.",
    };
  }

  const worktreePath = resolvePath(pathRaw, repoRoot);
  const git = input.git ?? defaultGitRunner;

  if (existsSync(worktreePath)) {
    if (!isLinkedWorktreePath(worktreePath)) {
      return {
        ok: false,
        code: "path-not-worktree",
        message: `dest-place refused: ${worktreePath} exists and is not a linked worktree`,
      };
    }
    let requestedOid = "";
    let actualOid = "";
    try {
      const want = git(
        ["rev-parse", "--verify", "--end-of-options", `${commitIsh}^{commit}`],
        repoRoot,
      );
      const have = git(["rev-parse", "HEAD"], worktreePath);
      if (want.returncode === 0) {
        requestedOid = (want.stdout.trim().split(/\s+/)[0] ?? "").toLowerCase();
      }
      if (have.returncode === 0) {
        actualOid = (have.stdout.trim().split(/\s+/)[0] ?? "").toLowerCase();
      }
    } catch {
      /* fall through to mismatch refuse */
    }
    if (requestedOid.length === 0 || actualOid.length === 0 || requestedOid !== actualOid) {
      return {
        ok: false,
        code: "revision-mismatch",
        message:
          `dest-place refused: existing worktree ${worktreePath} HEAD is ` +
          `${actualOid || "(missing)"} but requested commit-ish '${commitIsh}' ` +
          `resolves to ${requestedOid || "(unresolved)"}. Reuse requires a matching HEAD; ` +
          `pick a fresh path or reset the worktree to the requested commit.`,
      };
    }
    const repoMain = mainWorktreeRoot(repoRoot);
    const destMain = mainWorktreeRoot(worktreePath);
    if (repoMain === null || destMain === null || pathResolve(repoMain) !== pathResolve(destMain)) {
      return {
        ok: false,
        code: "foreign-worktree",
        message:
          `dest-place refused: ${worktreePath} is not a linked worktree of repoRoot ${repoRoot} ` +
          `(ownership check before deposit reconstitution).`,
      };
    }
    const reuseDeposit = reconstituteLinkedWorktreeDeposit(worktreePath, {
      preferPrimaryCore: true,
    });
    if (reuseDeposit.status === "refused") {
      return {
        ok: false,
        code: "deposit-refused",
        message:
          `dest-place refused reuse of ${worktreePath}: deposit reconstitution refused: ` +
          `${reuseDeposit.message}. Pick a fresh path or repair the payload source; ` +
          `this path was left in place (no force-remove).`,
      };
    }
    ensureSubagentStatusDir(worktreePath);
    return {
      ok: true,
      worktreePath,
      commitIsh,
      created: false,
      cwd: worktreePath,
    };
  }

  mkdirSync(dirname(worktreePath), { recursive: true });
  let proc: TextCaptureResult;
  try {
    proc = git(["worktree", "add", "--detach", worktreePath, commitIsh], repoRoot);
  } catch (exc: unknown) {
    return {
      ok: false,
      code: "worktree-add-failed",
      message: `dest-place failed running git worktree add --detach: ${String(exc)}`,
    };
  }
  if (proc.returncode !== 0) {
    return {
      ok: false,
      code: "worktree-add-failed",
      message:
        `\`git worktree add --detach ${worktreePath} ${commitIsh}\` failed ` +
        `(rc=${proc.returncode}): ${proc.stderr.trim() || "<no stderr>"}`,
    };
  }

  const deposit = reconstituteLinkedWorktreeDeposit(worktreePath, {
    preferPrimaryCore: true,
  });
  if (deposit.status === "refused") {
    return {
      ok: false,
      code: "deposit-refused",
      message:
        `dest-place deposit reconstitution refused for ${worktreePath}: ${deposit.message}. ` +
        `Worktree left in place (no force-remove). Retry reconstitutes the same path when HEAD matches; ` +
        `or pick a fresh path.`,
    };
  }

  ensureSubagentStatusDir(worktreePath);
  return {
    ok: true,
    worktreePath,
    commitIsh,
    created: true,
    cwd: worktreePath,
  };
}
