/**
 * session:ready — one-shot mutation recovery (#2993).
 *
 * Composes existing APIs (does not reimplement session:start or gated verify):
 *   1. Fast path when inspectSessionRitual(gated) is already green
 *   2. session:start when quick-tier state is missing/stale
 *   3. verifySessionRitual(--tier=gated) for doctor + cache_fresh
 *   4. cache fetch-all recovery when cache_fresh is the remaining blocker
 *   5. re-verify gated
 *
 * Exit 0 means a subsequent inspect/verify gated would pass (or the single
 * remaining hard blocker is printed once).
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { cacheFetchAll } from "../cache/fetch.js";
import { formatFrameworkCommand } from "../render/framework-commands.js";
import type { GitRunner } from "./git.js";
import {
  runSessionStart,
  type SessionStartOptions,
  type SessionStartResult,
} from "./session-start.js";
import {
  type InspectSessionRitualOptions,
  inspectSessionRitual,
  type RitualRunner,
  type VerifyResult,
  type VerifySessionRitualOptions,
  verifySessionRitual,
} from "./verify-session-ritual.js";

export const SESSION_READY_FAST_PATH = "fast";
export const SESSION_READY_RECOVERED = "recovered";
export const SESSION_READY_VERIFIED = "verified";
export const SESSION_READY_FAILED = "failed";

export type SessionReadyPath =
  | typeof SESSION_READY_FAST_PATH
  | typeof SESSION_READY_RECOVERED
  | typeof SESSION_READY_VERIFIED
  | typeof SESSION_READY_FAILED;

export interface SessionReadyResult {
  readonly code: number;
  readonly message: string;
  readonly path: SessionReadyPath;
  readonly lines: readonly string[];
  /** Steps actually executed (for tests / --json). */
  readonly steps: readonly string[];
  readonly duration_ms: number;
}

export type CacheFetchAllSeam = (options: {
  source: string;
  repo: string;
  force?: boolean;
  cacheRoot?: string;
}) => unknown;

export interface SessionReadyOptions {
  readonly now?: Date;
  readonly runGit?: GitRunner;
  readonly runner?: RitualRunner;
  readonly env?: NodeJS.ProcessEnv;
  /** When set, overrides DEFT_TRIAGE_REPO / git remote inference for cache recovery. */
  readonly repo?: string | null;
  readonly sessionStartOptions?: Omit<SessionStartOptions, "now" | "runGit" | "env">;
  readonly inspectRitual?: (
    projectRoot: string,
    options: InspectSessionRitualOptions,
  ) => VerifyResult;
  readonly verifyRitual?: (
    projectRoot: string,
    options: VerifySessionRitualOptions,
  ) => VerifyResult;
  readonly runStart?: (projectRoot: string, options: SessionStartOptions) => SessionStartResult;
  readonly fetchAll?: CacheFetchAllSeam;
  readonly inferRepo?: (projectRoot: string) => string | null;
  /** Skip cache recovery even when cache_fresh failed (tests). */
  readonly skipCacheRecovery?: boolean;
}

function elapsedMs(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

/** True when a gated verify failure is attributable to the cache_fresh step. */
export function isCacheFreshFailure(message: string): boolean {
  return /cache_fresh|cache-fresh|cache fetch-all|cache-fresh:|stale-by-drift|stale age/i.test(
    message,
  );
}

function normaliseRepoUrl(url: string): string | null {
  if (!url) return null;
  const cleaned = url
    .trim()
    .replace(/\/$/, "")
    .replace(/\.git$/, "");
  const match = cleaned.match(
    /^(?:(?:https?|ssh|git):\/\/)?(?:[^/@]+@)?github\.com[:/]+([^/]+)\/([^/]+)/i,
  );
  if (!match) return null;
  const owner = match[1];
  const repo = match[2];
  if (owner && repo) return `${owner}/${repo}`;
  return null;
}

/** Infer OWNER/NAME from DEFT_TRIAGE_REPO or git remote origin. */
export function inferSessionReadyRepo(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const fromEnv = (env.DEFT_TRIAGE_REPO ?? "").trim();
  if (fromEnv.length > 0 && fromEnv.includes("/")) return fromEnv;
  try {
    const stdout = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return normaliseRepoUrl(stdout.trim());
  } catch {
    return null;
  }
}

function readyCommand(): string {
  return formatFrameworkCommand(["session:ready"]);
}

/**
 * One-shot recovery: leave the worktree PreToolUse-gated-inspect green, or
 * print the single remaining blocker.
 */
export function runSessionReady(
  projectRoot: string,
  options: SessionReadyOptions = {},
): SessionReadyResult {
  const started = performance.now();
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  const lines: string[] = [];
  const steps: string[] = [];

  const inspect = options.inspectRitual ?? ((root, opts) => inspectSessionRitual(root, opts));
  const verify = options.verifyRitual ?? ((root, opts) => verifySessionRitual(root, opts));
  const start = options.runStart ?? ((root, opts) => runSessionStart(root, opts));
  const fetchAll = options.fetchAll ?? cacheFetchAll;
  const inferRepo = options.inferRepo ?? ((root) => inferSessionReadyRepo(root, env));

  // --- Fast path: already green for PreToolUse gated inspect ---
  const gatedInspect = inspect(projectRoot, {
    tier: "gated",
    posture: "mutation",
    now,
    runGit: options.runGit,
  });
  if (gatedInspect.code === 0) {
    const message = "OK session ready (gated ritual already fresh).";
    lines.push(message);
    return {
      code: 0,
      message,
      path: SESSION_READY_FAST_PATH,
      lines,
      steps,
      duration_ms: elapsedMs(started),
    };
  }

  // --- Ensure quick-tier ritual state when missing / stale / drifted ---
  const quickInspect = inspect(projectRoot, {
    tier: "quick",
    posture: "mutation",
    now,
    runGit: options.runGit,
  });
  if (quickInspect.code !== 0) {
    steps.push("session:start");
    const startResult = start(projectRoot, {
      ...options.sessionStartOptions,
      now,
      runGit: options.runGit,
      env,
      writeHistory: options.sessionStartOptions?.writeHistory ?? false,
    });
    for (const line of startResult.lines) {
      lines.push(line);
    }
    if (startResult.code !== 0) {
      const message =
        startResult.lines.join("\n").trim() ||
        `session:start failed (exit ${startResult.code}). Recovery: run \`${readyCommand()}\` again after fixing the blocker.`;
      lines.push(message);
      return {
        code: startResult.code === 0 ? 1 : startResult.code,
        message,
        path: SESSION_READY_FAILED,
        lines,
        steps,
        duration_ms: elapsedMs(started),
      };
    }
  }

  // --- Gated verify (lazy doctor + cache_fresh) ---
  steps.push("verify:session-ritual:gated");
  const verifyOpts: VerifySessionRitualOptions = {
    tier: "gated",
    posture: "mutation",
    now,
    runGit: options.runGit,
    runner: options.runner,
  };
  let verifyResult = verify(projectRoot, verifyOpts);
  if (verifyResult.code === 0) {
    const message = "OK session ready (gated ritual verified).";
    lines.push(message);
    return {
      code: 0,
      message,
      path: SESSION_READY_VERIFIED,
      lines,
      steps,
      duration_ms: elapsedMs(started),
    };
  }

  // --- Cache recovery when cache_fresh is the remaining blocker ---
  if (!options.skipCacheRecovery && isCacheFreshFailure(verifyResult.message)) {
    const repo = options.repo !== undefined ? options.repo : inferRepo(projectRoot);
    if (repo === null || repo.length === 0) {
      const message =
        `${verifyResult.message}\n` +
        `  Recovery: set DEFT_TRIAGE_REPO=OWNER/NAME or run \`deft cache fetch-all --source github-issue --repo OWNER/NAME --force\`, then \`${readyCommand()}\`.`;
      lines.push(message);
      return {
        code: 1,
        message,
        path: SESSION_READY_FAILED,
        lines,
        steps,
        duration_ms: elapsedMs(started),
      };
    }

    steps.push("cache:fetch-all");
    try {
      fetchAll({
        source: "github-issue",
        repo,
        force: true,
        cacheRoot: join(projectRoot, ".deft-cache"),
      });
      lines.push(`[session:ready] cache fetch-all completed for ${repo} (--force).`);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      const message =
        `session:ready cache recovery failed: ${detail}\n` +
        `  Recovery: run \`deft cache fetch-all --source github-issue --repo ${repo} --force\`, then \`${readyCommand()}\`.`;
      lines.push(message);
      return {
        code: 1,
        message,
        path: SESSION_READY_FAILED,
        lines,
        steps,
        duration_ms: elapsedMs(started),
      };
    }

    steps.push("verify:session-ritual:gated:retry");
    verifyResult = verify(projectRoot, verifyOpts);
    if (verifyResult.code === 0) {
      const message = "OK session ready (recovered via cache refresh).";
      lines.push(message);
      return {
        code: 0,
        message,
        path: SESSION_READY_RECOVERED,
        lines,
        steps,
        duration_ms: elapsedMs(started),
      };
    }
  }

  // --- Hard failure: surface the single remaining blocker ---
  const message =
    `${verifyResult.message}\n` +
    `  Remaining blocker after session:ready. Fix the step above, then re-run \`${readyCommand()}\`.`;
  lines.push(message);
  return {
    code: verifyResult.code === 0 ? 1 : verifyResult.code,
    message,
    path: SESSION_READY_FAILED,
    lines,
    steps,
    duration_ms: elapsedMs(started),
  };
}
