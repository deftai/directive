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
