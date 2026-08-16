import {
  formatAbsentRequiredMessage,
  readAbsentRequiredContexts,
  shouldEscalateAbsentRequired,
} from "./absent-required.js";
import { cadenceIntervalAfterPoll, cadenceIntervals } from "./cadence.js";
import {
  DEFAULT_CADENCE,
  EXIT_ABSENT_REQUIRED,
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

const GREPTILE_STALE_SHA_RE = /^Greptile last reviewed ([0-9a-f]+) but PR HEAD is ([0-9a-f]+)\./i;

/**
 * Truncate blocked-on text for one-line heartbeats while preserving
 * distinguishable SHA prefixes during update-branch races (#2581).
 */
export function truncateBlockedOn(failure: string, maxLen = 80): string {
  const match = GREPTILE_STALE_SHA_RE.exec(failure);
  if (match !== null) {
    const reviewedSha = match[1];
    const headSha = match[2];
    if (reviewedSha !== undefined && headSha !== undefined) {
      const compact =
        `Greptile last reviewed ${reviewedSha.slice(0, 12)}... ` +
        `but PR HEAD is ${headSha.slice(0, 12)}...`;
      if (compact.length <= maxLen) {
        return compact;
      }
    }
  }
  return failure.slice(0, maxLen);
}

/** Emit interim stderr heartbeats during long sleeps (#2581 / #2260). */
export function sleepWithCadenceHeartbeats(
  totalSeconds: number,
  priorCadenceSeconds: number,
  nextPollIndex: number,
  sleepFn: (seconds: number) => void,
): void {
  if (totalSeconds <= 0) {
    return;
  }
  const maxSilentGap = Math.max(1, priorCadenceSeconds * 2);
  if (totalSeconds <= maxSilentGap) {
    sleepFn(totalSeconds);
    return;
  }

  let remaining = totalSeconds;
  let emittedWait = false;
  while (remaining > 0) {
    const chunk = Math.min(remaining, maxSilentGap);
    if (!emittedWait) {
      process.stderr.write(
        `[monitor_pr] waiting ${Math.ceil(remaining)}s until poll #${nextPollIndex} ` +
          `(heartbeat cap ${maxSilentGap}s)\n`,
      );
      emittedWait = true;
    } else {
      process.stderr.write(
        `[monitor_pr] still waiting ${Math.ceil(remaining)}s until poll #${nextPollIndex}\n`,
      );
    }
    sleepFn(chunk);
    remaining -= chunk;
  }
}

/** Pull GitHub's merge-state signal out of a readiness payload, if present. */
export function mergeStateFromPayload(payload: Record<string, unknown>): string {
  const partialRaw = payload.partial_data;
  const partial =
    partialRaw !== null && typeof partialRaw === "object" && !Array.isArray(partialRaw)
      ? (partialRaw as Record<string, unknown>)
      : {};
  const mergeabilityRaw = partial.mergeability;
  if (
    mergeabilityRaw !== null &&
    typeof mergeabilityRaw === "object" &&
    !Array.isArray(mergeabilityRaw)
  ) {
    const state = (mergeabilityRaw as Record<string, unknown>).mergeable_state;
    if (typeof state === "string" && state.length > 0) {
      return state;
    }
  }
  // fallback2 surfaces mergeable_state directly on partial_data.
  const flatState = partial.mergeable_state;
  if (typeof flatState === "string" && flatState.length > 0) {
    return flatState;
  }
  return "?";
}

/**
 * One-line stderr heartbeat per poll (#2260): elapsed, poll#, via, head,
 * GitHub merge-state, CLEAN/BLOCKED, and what the poll is blocked on. Emitting
 * this every poll makes a live poll visibly distinct from a hung process.
 */
export function formatPollStatus(
  pollIndex: number,
  pollResult: PollResult,
  elapsedSeconds = 0,
): string {
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
  const elapsed = Math.max(0, Math.round(elapsedSeconds));
  const mergeState = mergeStateFromPayload(payload);
  let line =
    `[monitor_pr] poll #${pollIndex} t=${elapsed}s via=${via} head=${headDisplay} ` +
    `mergeState=${mergeState} ${label} (${failures.length} failures)`;
  if (firstFailure.length > 0) {
    line += ` -- blocked-on: ${truncateBlockedOn(firstFailure)}`;
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
  const cadence = options.cadence ?? DEFAULT_CADENCE;
  const capSeconds = (options.capMinutes ?? 60) * 60;
  const clockFn = options.clockFn ?? systemMonotonicClock;
  const sleepFn = options.sleepFn ?? defaultSleep;
  const callReadinessFn =
    options.callReadinessFn ??
    ((n, r) =>
      callReadiness(n, r, {
        runGh: options.runGh,
        projectRoot: options.projectRoot ?? process.cwd(),
      }));

  const startedAt = clockFn.now();
  const intervalSchedule = cadenceIntervals(cadence);
  const minCadenceSec =
    intervalSchedule.length > 0
      ? Math.min(...intervalSchedule)
      : cadenceIntervalAfterPoll(1, cadence);
  // Fail closed when an injected clock never advances (infinite poll loop; #2652).
  const maxPolls = Math.min(
    10_000,
    Math.ceil(capSeconds / Math.max(minCadenceSec, 1)) + intervalSchedule.length + 2,
  );
  let pollIndex = 0;
  let lastPayload: Record<string, unknown> = {};
  let lastExit = EXIT_CAP_REACHED;
  let priorCadenceSeconds = cadenceIntervalAfterPoll(1, cadence);
  let consecutiveAbsentRequired = 0;

  while (true) {
    pollIndex += 1;
    if (pollIndex > maxPolls) {
      return { exitCode: EXIT_CAP_REACHED, payload: lastPayload, pollCount: pollIndex - 1 };
    }
    const elapsed = clockFn.now() - startedAt;
    if (elapsed > capSeconds) {
      return { exitCode: EXIT_CAP_REACHED, payload: lastPayload, pollCount: pollIndex - 1 };
    }

    const pollResult = callReadinessFn(prNumber, repo);
    lastPayload = pollResult.payload;
    lastExit = pollResult.exitCode;

    const elapsedAtPoll = clockFn.now() - startedAt;
    process.stderr.write(`${formatPollStatus(pollIndex, pollResult, elapsedAtPoll)}\n`);
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

    const absentContexts = readAbsentRequiredContexts(lastPayload);
    if (absentContexts !== null) {
      consecutiveAbsentRequired += 1;
      if (shouldEscalateAbsentRequired(consecutiveAbsentRequired)) {
        const message = formatAbsentRequiredMessage(absentContexts);
        process.stderr.write(`[monitor_pr] ${message}\n`);
        return {
          exitCode: EXIT_ABSENT_REQUIRED,
          payload: {
            ...lastPayload,
            monitor_absent_required: [...absentContexts],
          },
          pollCount: pollIndex,
        };
      }
    } else {
      consecutiveAbsentRequired = 0;
    }

    const elapsedAfterPoll = clockFn.now() - startedAt;
    const remaining = capSeconds - elapsedAfterPoll;
    if (remaining <= 0) {
      const finalExit = lastExit === EXIT_CONFIG_ERROR ? EXIT_CONFIG_ERROR : EXIT_CAP_REACHED;
      return { exitCode: finalExit, payload: lastPayload, pollCount: pollIndex };
    }

    const sleepSeconds = Math.min(
      cadenceIntervalAfterPoll(pollIndex, cadence),
      Math.max(1, Math.trunc(remaining)),
    );
    sleepWithCadenceHeartbeats(sleepSeconds, priorCadenceSeconds, pollIndex + 1, sleepFn);
    priorCadenceSeconds = sleepSeconds;
  }
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
    case EXIT_ABSENT_REQUIRED:
      return "ABSENT-REQUIRED";
    default:
      return "UNKNOWN";
  }
};
