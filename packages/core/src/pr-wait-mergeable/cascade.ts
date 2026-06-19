import { classifyMonitorOutcome, parseMonitorPayload } from "./classify.js";
import { EXIT_CONFIG_ERROR, EXIT_MERGED, EXIT_TIMEOUT_OR_ESCALATION } from "./constants.js";
import { makeResult } from "./result.js";
import type { MergeFn, MonitorFn, ProtectedCheckFn, WaitMergeableResult } from "./types.js";
import { runGhMerge, runMonitor, runProtectedCheck } from "./wrappers.js";

export interface WaitMergeableOptions {
  readonly protectedFn?: ProtectedCheckFn;
  readonly monitorFn?: MonitorFn;
  readonly mergeFn?: MergeFn;
}

/** Run protected-check -> wait -> merge cascade (#1369). */
export function waitMergeableAndMerge(
  prNumber: number,
  repo: string,
  options: {
    readonly capMinutes: number;
    readonly protected: readonly number[];
  } & WaitMergeableOptions,
): WaitMergeableResult {
  const protectedFn = options.protectedFn ?? runProtectedCheck;
  const monitorFn = options.monitorFn ?? runMonitor;
  const mergeFn = options.mergeFn ?? runGhMerge;
  const protectedIssues = options.protected;

  let protectedCheckPayload: Record<string, unknown> = {};

  if (protectedIssues.length > 0) {
    const [prcRc, prcStdout, prcStderr] = protectedFn(prNumber, repo, protectedIssues);
    protectedCheckPayload = {
      returncode: prcRc,
      stdout: prcStdout,
      stderr: prcStderr,
      protected: [...protectedIssues],
    };

    if (prcRc === 1) {
      return makeResult({
        prNumber,
        repo,
        outcome: "protected-linked",
        exitCode: EXIT_TIMEOUT_OR_ESCALATION,
        protectedCheck: protectedCheckPayload,
        error:
          "PR has a persistent closingIssuesReferences link to a " +
          "protected issue (#701). Unlink via the PR's Development " +
          "sidebar before re-running.",
      });
    }

    if (prcRc !== 0) {
      return makeResult({
        prNumber,
        repo,
        outcome: "config-error",
        exitCode: EXIT_CONFIG_ERROR,
        protectedCheck: protectedCheckPayload,
        error:
          `protected-issue check exited ${prcRc} (config error). ` + `stderr: ${prcStderr.trim()}`,
      });
    }
  }

  const [monRc, monStdout, monStderr] = monitorFn(prNumber, repo, options.capMinutes);
  const monitorPayload = parseMonitorPayload(monStdout);
  const [outcome, monitorExit] = classifyMonitorOutcome(monRc, monitorPayload);

  if (outcome !== "clean") {
    const errorPayload =
      monitorExit === EXIT_MERGED
        ? null
        : monStderr.trim().length > 0
          ? `monitor exited ${monRc} (outcome=${outcome}). stderr tail: ${monStderr.trim().slice(-200)}`
          : `monitor exited ${monRc} (outcome=${outcome})`;

    return makeResult({
      prNumber,
      repo,
      outcome,
      exitCode: monitorExit,
      monitorResult: monitorPayload,
      protectedCheck: protectedCheckPayload,
      error: errorPayload,
    });
  }

  const [mergeRc, mergeStdout, mergeStderr] = mergeFn(prNumber, repo);

  if (mergeRc === 0) {
    return makeResult({
      prNumber,
      repo,
      outcome: "merged",
      exitCode: EXIT_MERGED,
      monitorResult: monitorPayload,
      protectedCheck: protectedCheckPayload,
      mergeStdout,
      mergeStderr,
      error: null,
    });
  }

  if (mergeRc === -1) {
    const tail = mergeStderr.trim();
    return makeResult({
      prNumber,
      repo,
      outcome: "config-error",
      exitCode: EXIT_CONFIG_ERROR,
      monitorResult: monitorPayload,
      protectedCheck: protectedCheckPayload,
      mergeStdout,
      mergeStderr,
      error:
        tail.length > 0
          ? `gh pr merge wrapper failed at OS layer (rc=-1). stderr: ${tail.slice(-200)}`
          : "gh pr merge wrapper failed at OS layer (rc=-1).",
    });
  }

  const mergeTail = mergeStderr.trim();
  return makeResult({
    prNumber,
    repo,
    outcome: "merge-failed",
    exitCode: EXIT_TIMEOUT_OR_ESCALATION,
    monitorResult: monitorPayload,
    protectedCheck: protectedCheckPayload,
    mergeStdout,
    mergeStderr,
    error:
      mergeTail.length > 0
        ? `gh pr merge exited ${mergeRc}. stderr: ${mergeTail.slice(-200)}`
        : `gh pr merge exited ${mergeRc}`,
  });
}
