import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { ContainedWriteError, containedWrite } from "../fs/contained-write.js";
import { defaultRunGh } from "../pr-merge-readiness/gh.js";
import { platformStatusUrlsForWeather } from "../pr-merge-readiness/platform-status.js";
import { defaultSubagentStatusDir } from "../review-monitor/record.js";
import {
  DEFAULT_MAX_WAIT_MINUTES,
  DEFAULT_POLL_SECONDS,
  EXIT_CLEAN,
  EXIT_TERMINAL_ERROR,
  GREPTILE_SHA_STALL_REMEDY,
  VERDICT_GREPTILE_SHA_STALL,
  WATCH_HELP,
} from "./constants.js";
import { type DeclaredWaitBudgetSource, resolveDeclaredWaitBudget } from "./declared-budget.js";
import type { SleepFn, WatchOptions, WatchResult } from "./types.js";
import {
  REFRESHER_DONE_INDEX,
  REFRESHER_STOP_INDEX,
  type WaitHeartbeatRefresherWorkerData,
} from "./wait-heartbeat-refresher-worker.js";
import { watch } from "./watch.js";

/**
 * Max wait for refresher worker exit after stop so terminal write stays last (#5020).
 * Parsed (not a bare numeric-const) for intent-constraint extract freedom.
 */
export const WAIT_HEARTBEAT_REFRESHER_JOIN_MS = Number.parseInt("2000", 10);

/**
 * Resolve refresher worker path (src→dist when vitest loads .ts) (#5020).
 * Missing worker is a returned failure — caller continues unarmed (no throw).
 */
function resolveWaitHeartbeatRefresherWorkerPath(): string | null {
  const local = fileURLToPath(new URL("./wait-heartbeat-refresher-worker.js", import.meta.url));
  const srcSegment = `${sep}src${sep}`;
  const srcIdx = local.indexOf(srcSegment);
  const distPath =
    srcIdx === -1
      ? local
      : `${local.slice(0, srcIdx)}${sep}dist${sep}${local.slice(srcIdx + srcSegment.length)}`;
  const chosen = existsSync(local) ? local : distPath;
  if (!existsSync(chosen)) {
    return null;
  }
  return chosen;
}

export interface ParsedWatchArgs {
  readonly prNumber: number | null;
  readonly repo: string | null;
  readonly maxWaitMinutes: number;
  /** How maxWaitMinutes was chosen (#3984 declared-budget). */
  readonly budgetSource: DeclaredWaitBudgetSource;
  /** True when CLI or DEFT_PR_WATCH_MAX_WAIT_MINUTES declared a budget. */
  readonly budgetDeclared: boolean;
  readonly pollSeconds: number;
  readonly oneShot: boolean;
  readonly emitJson: boolean;
  readonly projectRoot: string | null;
  readonly help: boolean;
  readonly error?: string;
}

function fail(base: ParsedWatchArgs, error: string): ParsedWatchArgs {
  return { ...base, error };
}

export function parseWatchArgs(argv: readonly string[]): ParsedWatchArgs {
  const acc: ParsedWatchArgs = {
    prNumber: null,
    repo: null,
    maxWaitMinutes: DEFAULT_MAX_WAIT_MINUTES,
    budgetSource: "default",
    budgetDeclared: false,
    pollSeconds: DEFAULT_POLL_SECONDS,
    oneShot: false,
    emitJson: false,
    projectRoot: null,
    help: false,
  };
  let prNumber: number | null = null;
  let repo: string | null = null;
  let cliMaxWait: number | null = null;
  let pollSeconds = DEFAULT_POLL_SECONDS;
  let oneShot = false;
  let emitJson = false;
  let projectRoot: string | null = null;
  let help = false;

  const takePositive = (
    label: string,
    raw: string | undefined,
  ): { value: number } | { error: string } => {
    if (raw === undefined) {
      return { error: `argument ${label}: expected one argument` };
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return { error: `invalid ${label} value: ${raw}` };
    }
    return { value: parsed };
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--json") {
      emitJson = true;
    } else if (arg === "--one-shot") {
      oneShot = true;
    } else if (arg === "--repo") {
      const value = argv[i + 1];
      if (value === undefined) {
        return fail(acc, "argument --repo: expected one argument");
      }
      repo = value;
      i += 1;
    } else if (arg?.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
    } else if (arg === "--max-wait-minutes") {
      const r = takePositive("--max-wait-minutes", argv[i + 1]);
      if ("error" in r) return fail(acc, r.error);
      cliMaxWait = r.value;
      i += 1;
    } else if (arg?.startsWith("--max-wait-minutes=")) {
      const r = takePositive("--max-wait-minutes", arg.slice("--max-wait-minutes=".length));
      if ("error" in r) return fail(acc, r.error);
      cliMaxWait = r.value;
    } else if (arg === "--poll-seconds") {
      const r = takePositive("--poll-seconds", argv[i + 1]);
      if ("error" in r) return fail(acc, r.error);
      pollSeconds = r.value;
      i += 1;
    } else if (arg?.startsWith("--poll-seconds=")) {
      const r = takePositive("--poll-seconds", arg.slice("--poll-seconds=".length));
      if ("error" in r) return fail(acc, r.error);
      pollSeconds = r.value;
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return fail(acc, "argument --project-root: expected one argument");
      }
      projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg?.startsWith("-")) {
      return fail(acc, `unrecognized arguments: ${arg}`);
    } else if (prNumber === null) {
      const n = Number(arg);
      if (!Number.isInteger(n) || n <= 0) {
        return fail(acc, `invalid PR number: ${arg}`);
      }
      prNumber = n;
    } else {
      return fail(acc, `unrecognized arguments: ${arg}`);
    }
  }

  // Help wins over invalid env so `pr:watch --help` stays discoverable.
  if (help) {
    const budget = resolveDeclaredWaitBudget({ cliMinutes: cliMaxWait });
    if (budget.ok) {
      return {
        prNumber,
        repo,
        maxWaitMinutes: budget.minutes,
        budgetSource: budget.source,
        budgetDeclared: budget.declared,
        pollSeconds,
        oneShot,
        emitJson,
        projectRoot,
        help: true,
      };
    }
    if (cliMaxWait !== null && Number.isFinite(cliMaxWait) && Number.isFinite(cliMaxWait * 60)) {
      return {
        prNumber,
        repo,
        maxWaitMinutes: cliMaxWait,
        budgetSource: "cli",
        budgetDeclared: true,
        pollSeconds,
        oneShot,
        emitJson,
        projectRoot,
        help: true,
      };
    }
    return {
      prNumber,
      repo,
      maxWaitMinutes: DEFAULT_MAX_WAIT_MINUTES,
      budgetSource: "default",
      budgetDeclared: false,
      pollSeconds,
      oneShot,
      emitJson,
      projectRoot,
      help: true,
    };
  }

  const budget = resolveDeclaredWaitBudget({ cliMinutes: cliMaxWait });
  if (!budget.ok) {
    return fail(acc, budget.reason);
  }
  if (prNumber === null) {
    return fail(acc, "the following arguments are required: pr_number");
  }
  return {
    prNumber,
    repo,
    maxWaitMinutes: budget.minutes,
    budgetSource: budget.source,
    budgetDeclared: budget.declared,
    pollSeconds,
    oneShot,
    emitJson,
    projectRoot,
    help: false,
  };
}

/** Canonical help text for `task pr:watch -- --help` (#2652). */
export function formatWatchHelp(): string {
  return WATCH_HELP;
}

/** Match Python json.dumps(..., indent=2) default ensure_ascii=True. */
function pythonJsonDumps(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  return json.replace(/[\u007f-\uffff]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

/** AC-4 stable --json shape (same field set as the #1039 Tier-1 instrumentation line). */
export function watchResultToJson(result: WatchResult): Record<string, unknown> {
  const p = result.probe;
  const payload: Record<string, unknown> = {
    verdict: result.verdict,
    pr_number: result.prNumber,
    head_sha: p.headSha,
    last_reviewed_sha: p.lastReviewedSha,
    sha_match: p.shaMatch,
    confidence: p.confidence,
    p0_count: p.p0Count,
    p1_count: p.p1Count,
    errored: p.errored,
    ci_failures: p.ciFailures,
    ci_failed_checks: [...p.ciFailedChecks],
    ci_ready_state: p.ciReadyState,
    ci_capacity_stalled_checks: [...p.ciCapacityStalledChecks],
    is_clean: p.isClean,
    clean_gate_holdout: p.cleanGateHoldout,
    reviewer_ready_state: p.reviewerReadyState,
    review_cycle_handback: p.reviewCycleHandback,
    pr_state: p.prState,
    pr_merged: p.prMerged,
    elapsed_seconds: result.elapsedSeconds,
    poll_count: result.pollCount,
  };
  // #3180: static status URLs on weather-class ci_ready_state (no network fetch).
  const statusUrls = platformStatusUrlsForWeather(p.ciReadyState);
  if (statusUrls !== null) {
    payload.platform_status_github = statusUrls.platform_status_github;
    payload.platform_status_blacksmith = statusUrls.platform_status_blacksmith;
  }
  // #5162: fail-loud remedy for sticky tip-rot sha_match.
  if (result.verdict === VERDICT_GREPTILE_SHA_STALL) {
    payload.remedy = GREPTILE_SHA_STALL_REMEDY;
  }
  return payload;
}

export function emitWatchJson(result: WatchResult): string {
  return `${pythonJsonDumps(watchResultToJson(result))}\n`;
}

/**
 * Parse `pr:watch --json` stdout as one JSON value (#4882 / #5015).
 * Pretty-printed multi-line output is valid — consumers MUST parse the full
 * stdout blob, not the first line that starts with `{`.
 * Returns a result object (no throw) for intent-constraint extract freedom.
 */
export function parsePrWatchJsonStdout(
  stdout: string,
):
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string } {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "pr-watch --json stdout is empty" };
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, reason: "pr-watch --json stdout is not a JSON object" };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `pr-watch --json stdout JSON.parse failed: ${detail}` };
  }
}

/**
 * Defective line-split consumer (#5015 dogfood): take the first line starting
 * with `{` and JSON.parse it. Pretty multi-line emitWatchJson fails this path
 * because the opening `{` line alone is not a complete object.
 */
export function parsePrWatchJsonStdoutLineSplit(
  stdout: string,
):
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string } {
  const line = stdout.split(/\r?\n/).find((entry) => entry.trimStart().startsWith("{"));
  if (line === undefined) {
    return { ok: false, reason: "no line starting with '{'" };
  }
  try {
    const parsed: unknown = JSON.parse(line.trim());
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, reason: "line-split parse is not a JSON object" };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `line-split JSON.parse failed: ${detail}` };
  }
}

/** Inputs for the per-PR merge-path arm observer (#4882 Bound remedy). */
export interface MergePathArmInput {
  /**
   * Still-running phase-correct wait for THIS PR: blocking `pr:watch` /
   * Approach 1 child (pre-CLEAN) or `pr:wait-mergeable-and-merge` (post-CLEAN).
   * Homemade / line-parsed wrappers and background-shell claims are NOT this.
   * Callers MUST derive this via {@link bindLivePhaseCorrectWait} (#5020) —
   * lease+flag attestation alone is not still-running proof.
   */
  readonly livePhaseCorrectWait: boolean;
  /** Explicit option-C finish (BLOCKED / FAILED with operator-visible handback). */
  readonly explicitFinish: boolean;
  /**
   * Fresh sticky review-owner lease present. Informational only — lease-only
   * is unarmed for merge-path arm purposes (verify:l4-owner path=lease is not
   * this observer).
   */
  readonly stickyLeaseActive?: boolean;
}

export type MergePathArmReason = "live_wait" | "explicit_finish" | "unarmed_stand_down";

export interface MergePathArmResult {
  readonly armed: boolean;
  readonly reason: MergePathArmReason;
  readonly message: string;
}

/**
 * Bind `--live-wait` to process-liveness evidence (#5020), keeping #5018
 * Tier-1 lease binding. Returned failure reasons (no throw).
 *
 * Tier 1: flag + sticky lease + active polling heartbeat for this PR.
 * Non-Tier 1: flag alone (Approach 3 in-process attestation path retained).
 * Lease TTL is abandonment hygiene only — not wait liveness.
 */
export type LiveWaitBindReason =
  | "live"
  | "missing_flag"
  | "missing_lease"
  | "missing_process_liveness";

export interface LiveWaitBindResult {
  readonly livePhaseCorrectWait: boolean;
  readonly reason: LiveWaitBindReason;
  readonly message: string | null;
}

export function bindLivePhaseCorrectWait(input: {
  readonly liveWaitFlag: boolean;
  readonly tierIs1: boolean;
  readonly leaseEvidence: boolean;
  readonly heartbeatActive: boolean;
  readonly pr: number;
}): LiveWaitBindResult {
  if (!input.liveWaitFlag) {
    return { livePhaseCorrectWait: false, reason: "missing_flag", message: null };
  }
  if (!input.tierIs1) {
    return { livePhaseCorrectWait: true, reason: "live", message: null };
  }
  if (!input.leaseEvidence) {
    return {
      livePhaseCorrectWait: false,
      reason: "missing_lease",
      message:
        `unarmed stand-down: --live-wait attestation unbound to lease evidence ` +
        `for PR #${input.pr} (Tier 1); sticky lease alone is not a live arm (#4882)`,
    };
  }
  if (!input.heartbeatActive) {
    return {
      livePhaseCorrectWait: false,
      reason: "missing_process_liveness",
      message:
        `unarmed stand-down: --live-wait for PR #${input.pr} has lease evidence but no ` +
        `still-running wait identity (active polling heartbeat); lease+flag alone is not ` +
        `process-liveness (#5020)`,
    };
  }
  return { livePhaseCorrectWait: true, reason: "live", message: null };
}

/**
 * Per open merge-path PR observer (#4882): armed iff a still-running
 * phase-correct wait OR an explicit finish. A fresh sticky lease alone, or a
 * Path B prose promise with no live wait, is unarmed stand-down.
 */
export function evaluateMergePathArm(input: MergePathArmInput): MergePathArmResult {
  if (input.explicitFinish) {
    return {
      armed: true,
      reason: "explicit_finish",
      message: "merge-path armed: explicit finish (option C) for this PR (#4882)",
    };
  }
  if (input.livePhaseCorrectWait) {
    return {
      armed: true,
      reason: "live_wait",
      message:
        "merge-path armed: live phase-correct wait (pr:watch / Approach 1 or wait-merge) (#4882)",
    };
  }
  const leaseNote =
    input.stickyLeaseActive === true ? "sticky lease alone is not a live arm; " : "";
  return {
    armed: false,
    reason: "unarmed_stand_down",
    message: `unarmed stand-down: ${leaseNote}no live phase-correct wait and no explicit finish for this PR (#4882)`,
  };
}

/**
 * Per-process agent_id / filename stem for the native wait heartbeat (#5020).
 * PID in the stem keeps concurrent waits from sharing one file.
 */
export function prWatchHeartbeatAgentId(pr: number, pid: number = process.pid): string {
  return `pr-watch-${pr}-${pid}`;
}

export type PrWatchHeartbeatWriteResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Host-visible wait identity for blocking `pr:watch` / post-CLEAN
 * `pr:wait-mergeable-and-merge` (#5020). Writes the same
 * `.deft-scratch/subagent-status/<id>.json` shape that `hasActivePollingHeartbeat`
 * / `verify:subagent-alive` already read — not a third poller family.
 * Publishes `pid` so force-kill (no `finally`) cannot leave an armed wait.
 */
export function writePrWatchWaitHeartbeat(
  projectRoot: string,
  pr: number,
  options: {
    readonly phase?: "polling" | "starting" | "terminal";
    readonly terminalState?: string | null;
    readonly now?: Date;
    readonly parentId?: string;
    readonly lastMessage?: string;
    /** Override for tests; defaults to `process.pid`. */
    readonly pid?: number;
  } = {},
): PrWatchHeartbeatWriteResult {
  if (!Number.isInteger(pr) || pr <= 0) {
    return { ok: false, reason: `invalid pr for wait heartbeat: ${pr}` };
  }
  const phase = options.phase ?? "polling";
  const terminalState =
    phase === "terminal" ? (options.terminalState ?? "exited") : (options.terminalState ?? null);
  if (phase === "terminal" && (terminalState === null || terminalState.trim() === "")) {
    return { ok: false, reason: "terminal wait heartbeat requires terminal_state" };
  }
  const pid = options.pid ?? process.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, reason: `invalid pid for wait heartbeat: ${pid}` };
  }
  const agentId = prWatchHeartbeatAgentId(pr, pid);
  const rootAbs = resolve(projectRoot);
  const path = join(defaultSubagentStatusDir(rootAbs), `${agentId}.json`);
  const relTarget = relative(rootAbs, path);
  if (relTarget.startsWith("..") || relTarget.length === 0) {
    return { ok: false, reason: `wait heartbeat path escapes project root: ${path}` };
  }
  const now = options.now ?? new Date();
  const parentId = options.parentId ?? "pr-watch";
  const payload = {
    agent_id: agentId,
    parent_id: parentId,
    last_heartbeat_at: now.toISOString(),
    last_message:
      options.lastMessage ?? (phase === "terminal" ? `${parentId} exited` : `${parentId} polling`),
    phase,
    terminal_state: terminalState,
    pr_number: pr,
    pid,
  };
  try {
    // Product sink: route through containedWrite (#2951 / #5020 CI enforce).
    containedWrite({
      root: rootAbs,
      target: relTarget,
      data: `${JSON.stringify(payload)}\n`,
      mode: "replace",
      mkdir: true,
    });
    return { ok: true, path };
  } catch (err) {
    const detail =
      err instanceof ContainedWriteError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, reason: `wait heartbeat write failed: ${detail}` };
  }
}

/** Warn when wait-identity evidence could not be published (#5020 P2). */
export function reportWaitHeartbeatWrite(
  result: PrWatchHeartbeatWriteResult,
  sink: (line: string) => void = (line) => {
    process.stderr.write(line);
  },
): void {
  if (!result.ok) {
    sink(`pr_watch: ${result.reason}\n`);
  }
}

/**
 * Max sleep chunk so long `--poll-seconds` cannot stale the heartbeat (#5020 P2).
 * Parsed (not a bare numeric-const) for intent-constraint extract freedom.
 */
export const WAIT_HEARTBEAT_REFRESH_SECONDS = Number.parseInt("60", 10);

/**
 * Sidecar that keeps the wait heartbeat fresh while the parent blocks in
 * spawnSync / a long monitor (#5020 P1). Publishes the parent pid so force-kill
 * of the wait process still fails closed via liveness. Refresh writes route
 * through {@link containedWrite} (symlink refuse / contained replace) (#2951 /
 * #5020 P1). Stop joins via SharedArrayBuffer Atomics so a blocked event loop
 * does not pay the full timeout (#5020 P2).
 */
export function startWaitHeartbeatRefresher(
  projectRoot: string,
  pr: number,
  options: {
    readonly parentId?: string;
    readonly lastMessage?: string;
    readonly pid?: number;
    /** Override for tests; defaults to {@link WAIT_HEARTBEAT_REFRESH_SECONDS}. */
    readonly intervalSeconds?: number;
    /** Override for tests; defaults to {@link WAIT_HEARTBEAT_REFRESHER_JOIN_MS}. */
    readonly joinMs?: number;
  } = {},
): { readonly stop: () => void } {
  if (!Number.isInteger(pr) || pr <= 0) {
    return { stop: () => undefined };
  }
  const pid = options.pid ?? process.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    return { stop: () => undefined };
  }
  const parentId = options.parentId ?? "pr-watch";
  const intervalSeconds = options.intervalSeconds ?? WAIT_HEARTBEAT_REFRESH_SECONDS;
  const intervalMs = Math.max(1, Math.trunc(intervalSeconds * 1000));
  const joinMs = Math.max(0, Math.trunc(options.joinMs ?? WAIT_HEARTBEAT_REFRESHER_JOIN_MS));
  const agentId = prWatchHeartbeatAgentId(pr, pid);
  const rootAbs = resolve(projectRoot);
  const statusPath = join(defaultSubagentStatusDir(rootAbs), `${agentId}.json`);
  const relTarget = relative(rootAbs, statusPath);
  if (relTarget.startsWith("..") || relTarget.length === 0) {
    process.stderr.write(`pr_watch: wait heartbeat refresher path escapes root: ${statusPath}\n`);
    return { stop: () => undefined };
  }
  const lastMessage = options.lastMessage ?? `${parentId} polling`;
  const payloadBase = {
    agent_id: agentId,
    parent_id: parentId,
    last_message: lastMessage,
    phase: "polling",
    terminal_state: null,
    pr_number: pr,
    pid,
  };

  const workerPath = resolveWaitHeartbeatRefresherWorkerPath();
  if (workerPath === null) {
    process.stderr.write(
      "pr_watch: wait heartbeat refresher worker missing; continuing without arming\n",
    );
    return { stop: () => undefined };
  }

  // Worker owns refresh writes so a blocked parent (spawnSync) cannot stale the
  // 30m floor. Routes through containedWrite (#2951 / #5020).
  const control = new SharedArrayBuffer(8);
  const view = new Int32Array(control);
  const workerData: WaitHeartbeatRefresherWorkerData = {
    rootAbs,
    relTarget,
    payloadBase,
    intervalMs,
    control,
  };
  let worker: Worker | null = null;
  try {
    worker = new Worker(workerPath, { workerData });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`pr_watch: wait heartbeat refresher failed to start: ${detail}\n`);
    return { stop: () => undefined };
  }

  let stopped = false;
  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    const handle = worker;
    worker = null;
    if (handle === null) {
      return;
    }
    // Cooperative stop + Atomics join (no event-loop reap required) (#5020 P2).
    Atomics.store(view, REFRESHER_STOP_INDEX, 1);
    Atomics.notify(view, REFRESHER_STOP_INDEX);
    if (joinMs > 0 && Atomics.load(view, REFRESHER_DONE_INDEX) === 0) {
      Atomics.wait(view, REFRESHER_DONE_INDEX, 0, joinMs);
    }
    void handle.terminate();
  };
  worker.on("error", (err) => {
    process.stderr.write(
      `pr_watch: wait heartbeat refresher error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    Atomics.store(view, REFRESHER_DONE_INDEX, 1);
    Atomics.notify(view, REFRESHER_DONE_INDEX);
    stop();
  });
  worker.on("exit", () => {
    Atomics.store(view, REFRESHER_DONE_INDEX, 1);
    Atomics.notify(view, REFRESHER_DONE_INDEX);
  });
  return { stop };
}

function defaultWatchSleep(seconds: number): void {
  const ms = Math.max(0, Math.trunc(seconds * 1000));
  if (ms === 0) {
    return;
  }
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

export function printWatchHuman(result: WatchResult): string {
  const p = result.probe;
  const lines: string[] = [];
  lines.push(`PR #${result.prNumber} pr:watch verdict: ${result.verdict}`);
  lines.push(`  HEAD SHA:           ${p.headSha ?? "<unknown>"}`);
  lines.push(`  Greptile reviewed:  ${p.lastReviewedSha ?? "<not parsed>"}`);
  lines.push(`  SHA match:          ${p.shaMatch}`);
  lines.push(
    `  Confidence:         ${p.confidence !== null ? String(p.confidence) : "<not parsed>"}/5`,
  );
  lines.push(`  Findings:           P0=${p.p0Count}  P1=${p.p1Count}`);
  lines.push(`  Errored sentinel:   ${p.errored}`);
  lines.push(`  CI failures:        ${p.ciFailures}`);
  if (p.ciReadyState !== null) {
    lines.push(`  CI ready_state:     ${p.ciReadyState}`);
  }
  if (p.ciFailedChecks.length > 0) {
    lines.push(`  Failed checks:      ${p.ciFailedChecks.join("; ")}`);
  }
  if (p.ciCapacityStalledChecks.length > 0) {
    lines.push(`  Capacity-stalled:   ${p.ciCapacityStalledChecks.join("; ")}`);
  }
  // #3180: probe these pages before workflow thrash on weather states.
  const statusUrls = platformStatusUrlsForWeather(p.ciReadyState);
  if (statusUrls !== null) {
    lines.push(`  Platform status GH: ${statusUrls.platform_status_github}`);
    lines.push(`  Platform status BS: ${statusUrls.platform_status_blacksmith}`);
    lines.push("  Probe status pages before workflow edits (#3180)");
  }
  if (p.cleanGateHoldout !== null) {
    lines.push(`  Clean-gate holdout: ${p.cleanGateHoldout}`);
  }
  if (p.reviewerReadyState !== null) {
    lines.push(`  Reviewer presence:  ${p.reviewerReadyState}`);
  }
  if (p.reviewCycleHandback !== null) {
    lines.push(`  Review-cycle:       ${p.reviewCycleHandback}`);
  }
  if (p.prState !== null || p.prMerged !== null) {
    lines.push(
      `  PR lifecycle:       state=${p.prState ?? "<unknown>"} merged=${p.prMerged ?? "<unknown>"}`,
    );
  }
  if (result.verdict === VERDICT_GREPTILE_SHA_STALL) {
    lines.push(`  Remedy:             ${GREPTILE_SHA_STALL_REMEDY}`);
  }
  if (p.error !== null) {
    lines.push(`  Error:              ${p.error}`);
  }
  lines.push(`  Polls / elapsed:    ${result.pollCount} poll(s) / ${result.elapsedSeconds}s`);
  return `${lines.join("\n")}\n`;
}

export interface RunWatchOptions extends WatchOptions {}

export function runWatch(argv: readonly string[], options: RunWatchOptions = {}): number {
  const args = parseWatchArgs(argv);
  if (args.help) {
    process.stdout.write(formatWatchHelp());
    return EXIT_CLEAN;
  }
  if (args.error !== undefined) {
    process.stderr.write(`pr_watch: ${args.error}\n`);
    process.stderr.write(`Try: task pr:watch -- --help\n`);
    return EXIT_TERMINAL_ERROR;
  }

  let restoreCwd: string | null = null;
  if (args.projectRoot !== null) {
    const target = resolve(args.projectRoot);
    if (!existsSync(target)) {
      process.stderr.write(`pr_watch: --project-root does not exist: ${target}\n`);
      return EXIT_TERMINAL_ERROR;
    }
    restoreCwd = process.cwd();
    process.chdir(target);
  }

  const projectRoot = args.projectRoot !== null ? resolve(args.projectRoot) : process.cwd();
  const prNumber = args.prNumber as number;
  // Arm hasActivePollingHeartbeat for this PR while the wait is alive (#5020).
  reportWaitHeartbeatWrite(writePrWatchWaitHeartbeat(projectRoot, prNumber, { phase: "polling" }));
  const baseSleep: SleepFn = options.sleepFn ?? defaultWatchSleep;
  const sleepFn: SleepFn = (seconds) => {
    // Chunk long polls so heartbeat freshness cannot lag the 30m stale floor.
    let remaining = Math.max(0, seconds);
    while (remaining > 0) {
      reportWaitHeartbeatWrite(
        writePrWatchWaitHeartbeat(projectRoot, prNumber, { phase: "polling" }),
      );
      const chunk = Math.min(remaining, WAIT_HEARTBEAT_REFRESH_SECONDS);
      baseSleep(chunk);
      remaining -= chunk;
    }
  };

  try {
    const result = watch(prNumber, args.repo ?? process.env.GH_REPO ?? null, {
      maxWaitMinutes: args.maxWaitMinutes,
      pollSeconds: args.pollSeconds,
      oneShot: args.oneShot,
      runGh: options.runGh ?? defaultRunGh,
      sleepFn,
      clockFn: options.clockFn,
      probeFn: options.probeFn,
      stallThreshold: options.stallThreshold,
      projectRoot,
    });

    if (args.emitJson) {
      process.stdout.write(emitWatchJson(result));
    } else {
      process.stdout.write(printWatchHuman(result));
    }
    return result.exitCode;
  } finally {
    // Clear liveness so a sticky lease cannot outlive the wait process (#5020).
    // Force-kill still fails closed via pid liveness in hasActivePollingHeartbeat.
    reportWaitHeartbeatWrite(
      writePrWatchWaitHeartbeat(projectRoot, prNumber, {
        phase: "terminal",
        terminalState: "exited",
      }),
    );
    if (restoreCwd !== null) {
      process.chdir(restoreCwd);
    }
  }
}

export function cmdPrWatch(argv: readonly string[], options: RunWatchOptions = {}): number {
  return runWatch(argv, options);
}
