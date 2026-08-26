/**
 * Release Step 3 issue-state fetch with capped rate-limit retry (#2577).
 * Open-issue inventory via one paginated REST subprocess (#3752).
 */
import { detectRateLimit } from "../cache/fetch.js";
import { IssueState } from "../intake/reconcile-issues.js";
import { type RunGhApiFn, GhRestError, restIssueListOpenInventory } from "../scm/gh-rest.js";
import { type CallOptions, type CompletedProcess, call } from "../scm/call.js";

export type ScmCallFn = (
  source: string,
  verb: string,
  args: readonly string[] | null,
  options?: CallOptions,
) => CompletedProcess;

/** Max seconds to sleep before the single rate-limit retry (operator-locked cap). */
export const MAX_RATE_LIMIT_RETRY_SLEEP_S = 120;

const X_RATE_LIMIT_RESET_RE = /X-RateLimit-Reset:\s*(\d+)/i;

export type SleepFn = (seconds: number) => void;

export interface RateLimitProbe {
  readonly coreRemaining: number | null;
  readonly coreResetUnix: number | null;
  readonly graphqlRemaining: number | null;
}

export interface FetchIssueStatesForReleaseOptions {
  readonly cwd?: string;
  readonly scmCall?: ScmCallFn;
  readonly sleep?: SleepFn;
  readonly now?: () => number;
}

export type FetchIssueStatesForReleaseResult =
  | {
      readonly ok: true;
      readonly states: Map<number, IssueState>;
    }
  | { readonly ok: false; readonly reason: string };

function defaultSleep(seconds: number): void {
  const ms = Math.max(0, Math.trunc(seconds * 1000));
  if (ms === 0) {
    return;
  }
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

function scmCallToRunGhApi(scmCall: ScmCallFn, cwd?: string): RunGhApiFn {
  return (args, options) => {
    const result = scmCall("github-issue", "api", args, {
      timeout: options?.timeout ?? 120,
      cwd,
    });
    return {
      returncode: result.returncode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
}

function buildStatesFromOpenInventory(
  issueNumbers: ReadonlySet<number>,
  openInventory: readonly Record<string, unknown>[],
): Map<number, IssueState> {
  const openNumbers = new Set<number>();
  for (const row of openInventory) {
    const n = row.number;
    if (typeof n === "number" && Number.isInteger(n)) {
      openNumbers.add(n);
    }
  }
  const states = new Map<number, IssueState>();
  for (const n of [...issueNumbers].sort((a, b) => a - b)) {
    states.set(n, openNumbers.has(n) ? new IssueState("OPEN") : new IssueState("NOT_FOUND"));
  }
  return states;
}

interface OpenInventoryAttempt {
  readonly inventory: Record<string, unknown>[] | null;
  readonly sawRateLimit: boolean;
  readonly rateLimitStderr: string;
  readonly failureReason: string | null;
}

function fetchOpenInventoryAttempt(
  repo: string,
  runGhApiFn: RunGhApiFn,
): OpenInventoryAttempt {
  let sawRateLimit = false;
  let rateLimitStderr = "";
  const trackingFn: RunGhApiFn = (args, options) => {
    const result = runGhApiFn(args, options);
    if (result.returncode !== 0 && detectRateLimit(result.stderr)[0]) {
      sawRateLimit = true;
      rateLimitStderr = result.stderr;
    }
    return result;
  };
  try {
    return {
      inventory: restIssueListOpenInventory(repo, { runGhApiFn: trackingFn }),
      sawRateLimit,
      rateLimitStderr,
      failureReason: null,
    };
  } catch (err) {
    const stderr = err instanceof GhRestError ? err.stderr : "";
    if (stderr.length > 0 && detectRateLimit(stderr)[0]) {
      sawRateLimit = true;
      rateLimitStderr = stderr;
    }
    const reason =
      err instanceof GhRestError
        ? `open-issue inventory fetch failed: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      inventory: null,
      sawRateLimit,
      rateLimitStderr,
      failureReason: reason,
    };
  }
}

function parseRateLimitProbe(stdout: string): RateLimitProbe | null {
  try {
    const body = JSON.parse(stdout) as unknown;
    if (typeof body !== "object" || body === null) {
      return null;
    }
    const resources = (body as { resources?: unknown }).resources;
    if (typeof resources !== "object" || resources === null) {
      return null;
    }
    const core = (resources as { core?: unknown }).core;
    const graphql = (resources as { graphql?: unknown }).graphql;
    if (
      typeof core !== "object" ||
      core === null ||
      Array.isArray(core) ||
      typeof graphql !== "object" ||
      graphql === null ||
      Array.isArray(graphql)
    ) {
      return null;
    }
    const coreRemainingRaw = (core as { remaining?: unknown }).remaining;
    const coreResetRaw = (core as { reset?: unknown }).reset;
    const graphqlRemainingRaw = (graphql as { remaining?: unknown }).remaining;
    const coreRemaining =
      coreRemainingRaw === undefined ? null : Number.parseInt(String(coreRemainingRaw), 10);
    const coreResetUnix =
      coreResetRaw === undefined ? null : Number.parseInt(String(coreResetRaw), 10);
    const graphqlRemaining =
      graphqlRemainingRaw === undefined ? null : Number.parseInt(String(graphqlRemainingRaw), 10);
    if (
      (coreRemaining !== null && Number.isNaN(coreRemaining)) ||
      (coreResetUnix !== null && Number.isNaN(coreResetUnix)) ||
      (graphqlRemaining !== null && Number.isNaN(graphqlRemaining))
    ) {
      return null;
    }
    return { coreRemaining, coreResetUnix, graphqlRemaining };
  } catch {
    return null;
  }
}

export function probeGithubRateLimit(scmCall: ScmCallFn, cwd?: string): RateLimitProbe | null {
  let result: CompletedProcess;
  try {
    result = scmCall("github-issue", "api", ["rate_limit"], { timeout: 30, cwd });
  } catch {
    return null;
  }
  if (result.returncode !== 0 || result.stdout.trim().length === 0) {
    return null;
  }
  return parseRateLimitProbe(result.stdout);
}

export function computeRateLimitSleepSeconds(
  stderr: string,
  probe: RateLimitProbe | null,
  nowSec: number,
): number {
  const [isRateLimit, retryAfter] = detectRateLimit(stderr);
  if (!isRateLimit) {
    return 0;
  }
  let candidate = retryAfter;
  const resetMatch = X_RATE_LIMIT_RESET_RE.exec(stderr);
  if (resetMatch?.[1]) {
    const resetAt = Number.parseInt(resetMatch[1], 10);
    if (!Number.isNaN(resetAt)) {
      candidate = Math.max(0, resetAt - nowSec + 1);
    }
  } else if (probe !== null && probe.coreResetUnix !== null) {
    candidate = Math.max(0, probe.coreResetUnix - nowSec + 1);
  }
  return Math.min(Math.max(1, candidate), MAX_RATE_LIMIT_RETRY_SLEEP_S);
}

export function formatRateLimitFailureDetails(
  probe: RateLimitProbe | null,
  rateLimitRelated: boolean,
): string {
  const lines: string[] = [];
  if (probe !== null) {
    const resetHint =
      probe.coreResetUnix !== null
        ? `core resets at ${new Date(probe.coreResetUnix * 1000).toISOString()}`
        : "run `gh api rate_limit` for reset time";
    lines.push(
      `GitHub rate limit probe: core.remaining=${probe.coreRemaining ?? "?"} graphql.remaining=${probe.graphqlRemaining ?? "?"} (${resetHint})`,
    );
  } else {
    lines.push("Probe `gh api rate_limit` for core.remaining and reset time.");
  }
  if (rateLimitRelated) {
    lines.push("Recovery: wait for the REST core bucket to reset, then re-run `task release`.");
    lines.push(
      "If local lifecycle validation is clean (`task vbrief:validate` exits 0), you may pass `--allow-vbrief-drift` to skip Step 3 for this cut.",
    );
  }
  return lines.join("\n");
}

export function fetchIssueStatesForRelease(
  repo: string,
  issueNumbers: ReadonlySet<number>,
  options: FetchIssueStatesForReleaseOptions = {},
): FetchIssueStatesForReleaseResult {
  if (issueNumbers.size === 0) {
    return { ok: true, states: new Map() };
  }

  process.stderr.write(
    `[release Step 3] checking ${issueNumbers.size} unique anchored issue(s) via open-issue inventory\n`,
  );

  const sleepFn = options.sleep ?? defaultSleep;
  const nowFn = options.now ?? (() => Math.floor(Date.now() / 1000));
  const baseScmCall = options.scmCall ?? call;
  const cwd = options.cwd ?? undefined;
  const runGhApiFn = scmCallToRunGhApi(baseScmCall, cwd);

  const finishSuccess = (
    inventory: readonly Record<string, unknown>[],
  ): FetchIssueStatesForReleaseResult => {
    process.stderr.write(
      `[release Step 3] open-issue inventory: ${inventory.length} open issue(s)\n`,
    );
    return { ok: true, states: buildStatesFromOpenInventory(issueNumbers, inventory) };
  };

  let attempt = fetchOpenInventoryAttempt(repo, runGhApiFn);
  if (attempt.inventory !== null) {
    return finishSuccess(attempt.inventory);
  }

  if (attempt.sawRateLimit) {
    const probe = probeGithubRateLimit(baseScmCall, cwd);
    const sleepS = computeRateLimitSleepSeconds(attempt.rateLimitStderr, probe, nowFn());
    process.stderr.write(
      `[release Step 3] GitHub REST rate limit hit; sleeping ${sleepS}s before one retry\n`,
    );
    sleepFn(sleepS);
    attempt = fetchOpenInventoryAttempt(repo, runGhApiFn);
    if (attempt.inventory !== null) {
      return finishSuccess(attempt.inventory);
    }
  }

  const rateLimitRelated = attempt.sawRateLimit || attempt.rateLimitStderr.length > 0;
  if (rateLimitRelated) {
    const probe = probeGithubRateLimit(baseScmCall, cwd);
    const details = formatRateLimitFailureDetails(probe, true);
    process.stderr.write(`${details}\n`);
    return {
      ok: false,
      reason: "GitHub REST rate limit exhausted (see stderr for recovery steps)",
    };
  }

  process.stderr.write(`${attempt.failureReason ?? "open-issue inventory fetch failed"}\n`);
  return { ok: false, reason: "failed to fetch issue states from gh" };
}
