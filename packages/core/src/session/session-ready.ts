/**
 * session:ready — one-shot mutation recovery (#2993).
 *
 * Composes existing APIs (does not reimplement session:start or gated verify):
 *   1. Fast path when inspectSessionRitual(gated) is already green
 *   2. session:start when quick-tier state is missing/stale
 *   3. verifySessionRitual(--tier=gated) with check-class cache_fresh
 *      (age + live drift, no --skip-drift-probe) so skip-drift-green cannot
 *      hide stale-by-drift (#4399)
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
  type ApplyOccupancyInput,
  applyWorktreeOccupancy,
  type OccupancyDecision,
  resolveOccupancySessionId,
} from "./occupancy.js";
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
  /** One resolved owner carried through preview, verification, and claim (#3611). */
  readonly sessionId: string;
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
  /** Explicit lifecycle owner resolved by the host/session bridge (#3611). */
  readonly sessionId?: string;
  /** When set, overrides DEFT_TRIAGE_REPO / git remote inference for cache recovery. */
  readonly repo?: string | null;
  readonly sessionStartOptions?: Omit<SessionStartOptions, "now" | "runGit" | "env" | "sessionId">;
  readonly inspectRitual?: (
    projectRoot: string,
    options: InspectSessionRitualOptions,
  ) => VerifyResult;
  readonly verifyRitual?: (
    projectRoot: string,
    options: VerifySessionRitualOptions,
  ) => VerifyResult;
  readonly runStart?: (projectRoot: string, options: SessionStartOptions) => SessionStartResult;
  readonly applyOccupancy?: (projectRoot: string, input: ApplyOccupancyInput) => OccupancyDecision;
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

/**
 * True readiness for PreToolUse: exit 0 without DEFT_SESSION_RITUAL_SKIP bypass.
 * Bypassed code 0 does not make inspectSessionRitual green (#2993 Greptile P1).
 */
export function isGatedVerifyActuallyReady(result: VerifyResult): boolean {
  return result.code === 0 && !result.bypassed;
}

function bypassedReadyFailure(result: VerifyResult): string {
  const detail =
    result.message.trim().length > 0
      ? result.message
      : "session ritual verification was bypassed (DEFT_SESSION_RITUAL_SKIP)";
  return (
    `${detail}\n` +
    `  session:ready refuses bypassed verification (would not pass PreToolUse inspect). ` +
    `Unset DEFT_SESSION_RITUAL_SKIP and re-run \`${readyCommand()}\`.`
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
  // #3611: resolve once before any occupancy preview or nested lifecycle call.
  // A nested start must report the same persisted owner; adopting a different
  // result would silently split the invocation's identity.
  const sessionId = resolveOccupancySessionId({
    sessionId: options.sessionId,
    env,
    newSessionId: options.sessionStartOptions?.newSessionId,
  });
  let nestedStartClaimedOccupancy = false;

  const inspect = options.inspectRitual ?? inspectSessionRitual;
  const verify = options.verifyRitual ?? verifySessionRitual;
  const start = options.runStart ?? runSessionStart;
  const fetchAll = options.fetchAll ?? cacheFetchAll;
  const inferRepo = options.inferRepo ?? ((root) => inferSessionReadyRepo(root, env));
  const applyOccupancy = options.applyOccupancy ?? applyWorktreeOccupancy;
  const occupancyInput = (write: boolean, steal: boolean): ApplyOccupancyInput => ({
    sessionId,
    env,
    now,
    steal,
    confirm: options.sessionStartOptions?.confirm,
    occupant: options.sessionStartOptions?.occupant,
    intent: options.sessionStartOptions?.occupancyIntent ?? "mutation",
    write,
  });
  const requestedSteal = options.sessionStartOptions?.steal === true;
  const previewOccupancy = applyOccupancy(projectRoot, occupancyInput(false, requestedSteal));
  if (previewOccupancy.code !== 0) {
    const message = previewOccupancy.message;
    lines.push(message);
    return {
      code: previewOccupancy.code,
      sessionId,
      message,
      path: SESSION_READY_FAILED,
      lines,
      steps,
      duration_ms: elapsedMs(started),
    };
  }
  const claimOnSuccess = (): OccupancyDecision =>
    applyOccupancy(
      projectRoot,
      occupancyInput(true, nestedStartClaimedOccupancy ? false : requestedSteal),
    );
  const finishReady = (path: SessionReadyPath, message: string): SessionReadyResult => {
    const claimed = claimOnSuccess();
    if (claimed.code !== 0) {
      lines.push(claimed.message);
      return {
        code: claimed.code,
        sessionId,
        message: claimed.message,
        path: SESSION_READY_FAILED,
        lines,
        steps,
        duration_ms: elapsedMs(started),
      };
    }
    // The verified ritual can change while the final occupancy claim is being
    // persisted. Re-read only the exact bound ritual owner after the claim;
    // never return success with a lease/ritual split (#3611). Files remain a
    // cooperative gate, so this narrows rather than eliminates TOCTOU.
    const postClaimRitual = inspect(projectRoot, {
      tier: "gated",
      posture: "mutation",
      now,
      runGit: options.runGit,
    });
    if (postClaimRitual.code !== 0 || postClaimRitual.boundSessionId !== sessionId) {
      const actual = postClaimRitual.boundSessionId ?? "<unbound>";
      const detail =
        postClaimRitual.code === 0
          ? `post-claim ritual owner ${actual}`
          : `post-claim ritual inspection failed: ${postClaimRitual.message}`;
      const failure =
        `session:ready ${detail}, but occupancy is held by ${sessionId}. ` +
        "Readiness remains fail-closed. Re-run session:start with the same explicit " +
        "--session-id to align ritual and occupancy state.";
      lines.push(failure);
      return {
        code: postClaimRitual.code === 0 ? 1 : postClaimRitual.code,
        sessionId,
        message: failure,
        path: SESSION_READY_FAILED,
        lines,
        steps,
        duration_ms: elapsedMs(started),
      };
    }
    lines.push(message);
    return {
      code: 0,
      sessionId,
      message,
      path,
      lines,
      steps,
      duration_ms: elapsedMs(started),
    };
  };
  const ownerAlignmentFailure = (
    actualOwner: string | undefined,
    context = "verified ritual",
  ): SessionReadyResult => {
    const actual = actualOwner ?? "<unbound>";
    const message =
      `session:ready ${context} owner ${actual}, but the resolved occupancy owner is ` +
      `${sessionId}. Refusing to claim a mismatched lease. Re-run session:start with the ` +
      "same explicit --session-id to align ritual and occupancy state.";
    lines.push(message);
    return {
      code: 1,
      sessionId,
      message,
      path: SESSION_READY_FAILED,
      lines,
      steps,
      duration_ms: elapsedMs(started),
    };
  };

  const verifyOpts: VerifySessionRitualOptions = {
    tier: "gated",
    posture: "mutation",
    now,
    runGit: options.runGit,
    runner: options.runner,
    // Check-class cache_fresh (age + live drift, no --skip-drift-probe) so
    // skip-drift-green cannot hide stale-by-drift from isCacheFreshFailure (#4399).
    forceGatedSteps: ["agent_hooks", "cache_fresh"],
    checkClassCacheFresh: true,
  };

  // --- Fast path: inspect is green, but refresh functional hook readiness before returning. ---
  const gatedInspect = inspect(projectRoot, {
    tier: "gated",
    posture: "mutation",
    now,
    runGit: options.runGit,
  });
  // A confirmed owner transition must also rewrite ritual state. Even a green
  // legacy ritual cannot take the fast path, because stealing only in the
  // final occupancy claim would leave lease and ritual owners mismatched.
  let verifyResult: VerifyResult | undefined;
  if (gatedInspect.code === 0 && gatedInspect.boundSessionId === sessionId && !requestedSteal) {
    steps.push("verify:session-ritual:gated");
    const refreshed = verify(projectRoot, verifyOpts);
    if (isGatedVerifyActuallyReady(refreshed)) {
      if (refreshed.boundSessionId !== sessionId) {
        return ownerAlignmentFailure(refreshed.boundSessionId);
      }
      return finishReady(SESSION_READY_FAST_PATH, "OK session ready (gated ritual already fresh).");
    }
    if (refreshed.code === 0 && refreshed.bypassed) {
      const message = bypassedReadyFailure(refreshed);
      lines.push(message);
      return {
        code: 1,
        sessionId,
        message,
        path: SESSION_READY_FAILED,
        lines,
        steps,
        duration_ms: elapsedMs(started),
      };
    }
    if (!options.skipCacheRecovery && isCacheFreshFailure(refreshed.message)) {
      // Inspect-green can still be skip-drift-green; check-class stale-by-drift
      // must still reach fetch-all (#4399). Incident path remains VERIFIED.
      verifyResult = refreshed;
    } else {
      const message = `${refreshed.message}\n  Remaining blocker after session:ready. Fix the step above, then re-run \`${readyCommand()}\`.`;
      lines.push(message);
      return {
        code: refreshed.code === 0 ? 1 : refreshed.code,
        sessionId,
        message,
        path: SESSION_READY_FAILED,
        lines,
        steps,
        duration_ms: elapsedMs(started),
      };
    }
  }

  if (verifyResult === undefined) {
    // --- Ensure quick-tier ritual state when missing / stale / drifted ---
    const quickInspect = inspect(projectRoot, {
      tier: "quick",
      posture: "mutation",
      now,
      runGit: options.runGit,
    });
    if (quickInspect.code !== 0 || quickInspect.boundSessionId !== sessionId || requestedSteal) {
      steps.push("session:start");
      const startResult = start(projectRoot, {
        ...options.sessionStartOptions,
        now,
        runGit: options.runGit,
        env,
        sessionId,
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
          code: startResult.code,
          sessionId,
          message,
          path: SESSION_READY_FAILED,
          lines,
          steps,
          duration_ms: elapsedMs(started),
        };
      }
      const startedOccupancy = startResult.payload.occupancy;
      if (
        startedOccupancy !== null &&
        typeof startedOccupancy === "object" &&
        !Array.isArray(startedOccupancy)
      ) {
        const persistedSessionId = (startedOccupancy as Record<string, unknown>).session_id;
        if (typeof persistedSessionId === "string" && persistedSessionId.trim().length > 0) {
          if (persistedSessionId.trim() !== sessionId) {
            return ownerAlignmentFailure(persistedSessionId.trim(), "nested session:start");
          }
          nestedStartClaimedOccupancy = true;
        }
      }
    }

    // --- Gated verify (check-class cache_fresh so skip-drift cannot hide drift) ---
    steps.push("verify:session-ritual:gated");
    verifyResult = verify(projectRoot, verifyOpts);
    if (isGatedVerifyActuallyReady(verifyResult)) {
      if (verifyResult.boundSessionId !== sessionId) {
        return ownerAlignmentFailure(verifyResult.boundSessionId);
      }
      return finishReady(SESSION_READY_VERIFIED, "OK session ready (gated ritual verified).");
    }
    if (verifyResult.code === 0 && verifyResult.bypassed) {
      const message = bypassedReadyFailure(verifyResult);
      lines.push(message);
      return {
        code: 1,
        sessionId,
        message,
        path: SESSION_READY_FAILED,
        lines,
        steps,
        duration_ms: elapsedMs(started),
      };
    }
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
        sessionId,
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
        sessionId,
        message,
        path: SESSION_READY_FAILED,
        lines,
        steps,
        duration_ms: elapsedMs(started),
      };
    }

    steps.push("verify:session-ritual:gated:retry");
    verifyResult = verify(projectRoot, { ...verifyOpts, forceGatedSteps: [] });
    if (isGatedVerifyActuallyReady(verifyResult)) {
      if (verifyResult.boundSessionId !== sessionId) {
        return ownerAlignmentFailure(verifyResult.boundSessionId);
      }
      return finishReady(
        SESSION_READY_RECOVERED,
        "OK session ready (recovered via cache refresh).",
      );
    }
    if (verifyResult.code === 0 && verifyResult.bypassed) {
      const message = bypassedReadyFailure(verifyResult);
      lines.push(message);
      return {
        code: 1,
        sessionId,
        message,
        path: SESSION_READY_FAILED,
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
    code: verifyResult.code,
    sessionId,
    message,
    path: SESSION_READY_FAILED,
    lines,
    steps,
    duration_ms: elapsedMs(started),
  };
}
