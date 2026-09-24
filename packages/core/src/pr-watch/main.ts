import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defaultRunGh } from "../pr-merge-readiness/gh.js";
import { platformStatusUrlsForWeather } from "../pr-merge-readiness/platform-status.js";
import {
  DEFAULT_MAX_WAIT_MINUTES,
  DEFAULT_POLL_SECONDS,
  EXIT_CLEAN,
  EXIT_TERMINAL_ERROR,
  WATCH_HELP,
} from "./constants.js";
import type { WatchOptions, WatchResult } from "./types.js";
import { watch } from "./watch.js";

export interface ParsedWatchArgs {
  readonly prNumber: number | null;
  readonly repo: string | null;
  readonly maxWaitMinutes: number;
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
    pollSeconds: DEFAULT_POLL_SECONDS,
    oneShot: false,
    emitJson: false,
    projectRoot: null,
    help: false,
  };
  let prNumber: number | null = null;
  let repo: string | null = null;
  let maxWaitMinutes = DEFAULT_MAX_WAIT_MINUTES;
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
      maxWaitMinutes = r.value;
      i += 1;
    } else if (arg?.startsWith("--max-wait-minutes=")) {
      const r = takePositive("--max-wait-minutes", arg.slice("--max-wait-minutes=".length));
      if ("error" in r) return fail(acc, r.error);
      maxWaitMinutes = r.value;
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

  if (help) {
    return { prNumber, repo, maxWaitMinutes, pollSeconds, oneShot, emitJson, projectRoot, help };
  }
  if (prNumber === null) {
    return fail(acc, "the following arguments are required: pr_number");
  }
  return {
    prNumber,
    repo,
    maxWaitMinutes,
    pollSeconds,
    oneShot,
    emitJson,
    projectRoot,
    help,
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
    elapsed_seconds: result.elapsedSeconds,
    poll_count: result.pollCount,
  };
  // #3180: static status URLs on weather-class ci_ready_state (no network fetch).
  const statusUrls = platformStatusUrlsForWeather(p.ciReadyState);
  if (statusUrls !== null) {
    payload.platform_status_github = statusUrls.platform_status_github;
    payload.platform_status_blacksmith = statusUrls.platform_status_blacksmith;
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

  try {
    const result = watch(args.prNumber as number, args.repo ?? process.env.GH_REPO ?? null, {
      maxWaitMinutes: args.maxWaitMinutes,
      pollSeconds: args.pollSeconds,
      oneShot: args.oneShot,
      runGh: options.runGh ?? defaultRunGh,
      sleepFn: options.sleepFn,
      clockFn: options.clockFn,
      probeFn: options.probeFn,
      stallThreshold: options.stallThreshold,
      projectRoot: args.projectRoot ?? process.cwd(),
    });

    if (args.emitJson) {
      process.stdout.write(emitWatchJson(result));
    } else {
      process.stdout.write(printWatchHuman(result));
    }
    return result.exitCode;
  } finally {
    if (restoreCwd !== null) {
      process.chdir(restoreCwd);
    }
  }
}

export function cmdPrWatch(argv: readonly string[], options: RunWatchOptions = {}): number {
  return runWatch(argv, options);
}
