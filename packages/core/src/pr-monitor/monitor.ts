import { cadenceIntervals } from "./cadence.js";
import {
  DEFAULT_CADENCE,
  EXIT_CAP_REACHED,
  EXIT_CLEAN,
  EXIT_CONFIG_ERROR,
  EXIT_PR_TERMINAL,
} from "./constants.js";
import { callReadiness } from "./readiness.js";
import type { MonitorOptions, MonitorRunResult, PollResult } from "./types.js";

const systemMonotonicClock = {
  now(): number {
    return performance.now() / 1000;
  },
};

function defaultSleep(seconds: number): void {
  const start = Date.now();
  const target = start + seconds * 1000;
  while (Date.now() < target) {
    // busy-wait fallback when no injectable sleep in production CLI path
  }
}

/** One-line stderr status mirror per poll. */
export function formatPollStatus(pollIndex: number, pollResult: PollResult): string {
  const payload = pollResult.payload;
  const via = typeof payload.via === "string" ? payload.via : "?";
  const mergeReady = payload.merge_ready === true;
  let headSha = payload.head_sha;
  if (headSha === null || headSha === undefined) {
    headSha = "<unknown>";
  }
  let headDisplay = String(headSha);
  if (typeof headDisplay === "string") {
    headDisplay = headDisplay.slice(0, 12);
  }
  const failuresRaw = payload.failures;
  const failures = Array.isArray(failuresRaw) ? failuresRaw.map(String) : [];
  const firstFailure = failures[0] ?? "";
  const label = mergeReady ? "CLEAN" : "BLOCKED";
  let line =
    `[monitor_pr] poll #${pollIndex} via=${via} head=${headDisplay} ` +
    `${label} (${failures.length} failures)`;
  if (firstFailure.length > 0) {
    line += ` -- ${firstFailure.slice(0, 80)}`;
  }
  return line;
}

/** Detect merged / closed PR via fallback2 partial_data. */
export function isTerminalPrState(payload: Record<string, unknown>): boolean {
  const partialRaw = payload.partial_data;
  const partial =
    partialRaw !== null && typeof partialRaw === "object" && !Array.isArray(partialRaw)
      ? (partialRaw as Record<string, unknown>)
      : {};
  return partial.merged === true || partial.pr_state === "closed";
}

/** Loop readiness with adaptive cadence until CLEAN / cap / terminal. */
export function monitor(
  prNumber: number,
  repo: string,
  options: MonitorOptions = {},
): MonitorRunResult {
  const intervals = cadenceIntervals(options.cadence ?? DEFAULT_CADENCE);
  const capSeconds = (options.capMinutes ?? 60) * 60;
  const clockFn = options.clockFn ?? systemMonotonicClock;
  const sleepFn = options.sleepFn ?? defaultSleep;
  const callReadinessFn =
    options.callReadinessFn ?? ((n, r) => callReadiness(n, r, { runGh: options.runGh }));

  const startedAt = clockFn.now();
  let pollIndex = 0;
  let lastPayload: Record<string, unknown> = {};
  let lastExit = EXIT_CAP_REACHED;

  for (const interval of intervals) {
    pollIndex += 1;
    const elapsed = clockFn.now() - startedAt;
    if (elapsed > capSeconds) {
      return { exitCode: EXIT_CAP_REACHED, payload: lastPayload, pollCount: pollIndex - 1 };
    }

    const pollResult = callReadinessFn(prNumber, repo);
    lastPayload = pollResult.payload;
    lastExit = pollResult.exitCode;

    process.stderr.write(`${formatPollStatus(pollIndex, pollResult)}\n`);
    if (pollResult.rawStderr.trim().length > 0) {
      process.stderr.write(pollResult.rawStderr);
    }

    const via = lastPayload.via;
    const mergeReady = lastPayload.merge_ready === true;

    if (mergeReady && (via === "primary" || via === "fallback1")) {
      return { exitCode: EXIT_CLEAN, payload: lastPayload, pollCount: pollIndex };
    }

    if (isTerminalPrState(lastPayload)) {
      return { exitCode: EXIT_PR_TERMINAL, payload: lastPayload, pollCount: pollIndex };
    }

    if (pollIndex < intervals.length) {
      const elapsedAfterPoll = clockFn.now() - startedAt;
      const remaining = capSeconds - elapsedAfterPoll;
      if (remaining <= 0) {
        return { exitCode: EXIT_CAP_REACHED, payload: lastPayload, pollCount: pollIndex };
      }
      sleepFn(Math.min(interval, Math.max(1, Math.trunc(remaining))));
    }
  }

  const finalExit = lastExit === EXIT_CONFIG_ERROR ? EXIT_CONFIG_ERROR : EXIT_CAP_REACHED;
  return { exitCode: finalExit, payload: lastPayload, pollCount: pollIndex };
}

export const summaryLabelForExit = (exitCode: number): string => {
  switch (exitCode) {
    case EXIT_CLEAN:
      return "CLEAN";
    case EXIT_CAP_REACHED:
      return "CAP-REACHED";
    case EXIT_PR_TERMINAL:
      return "PR-TERMINAL";
    case EXIT_CONFIG_ERROR:
      return "CONFIG-ERROR";
    default:
      return "UNKNOWN";
  }
};
