import type { CheckRunRecord } from "./gh.js";

const FAILED_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out"]);
const PENDING_STATUSES = new Set(["queued", "in_progress"]);

export type CiReadyState = "ready" | "blocked" | "not_ready_yet" | "skipped";

export interface CiGateOptions {
  readonly skipCi?: boolean;
  readonly ignoreCheckNames?: readonly string[];
}

export interface CiCheckConclusion {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string;
  readonly required: boolean;
  readonly ignored: boolean;
}

export interface CiGateSummary {
  readonly ready_state: CiReadyState;
  readonly checked_count: number;
  readonly ignored_checks: readonly string[];
  readonly failed_required: readonly string[];
  readonly pending_required: readonly string[];
  readonly conclusions: readonly CiCheckConclusion[];
}

export interface CiGateResult {
  readonly failures: readonly string[];
  readonly summary: CiGateSummary;
}

function isPending(status: string, conclusion: string): boolean {
  if (PENDING_STATUSES.has(status)) {
    return true;
  }
  return status !== "completed" || conclusion === "none";
}

export function buildCiSummaryLine(summary: CiGateSummary): string {
  const passed =
    summary.checked_count - summary.failed_required.length - summary.pending_required.length;
  return (
    `CI check-runs: ${passed} passed / ` +
    `${summary.failed_required.length} failed / ${summary.pending_required.length} pending`
  );
}

export function evaluateCiGate(
  checkRuns: readonly CheckRunRecord[],
  options: CiGateOptions = {},
): CiGateResult {
  if (options.skipCi === true) {
    return {
      failures: [],
      summary: {
        ready_state: "skipped",
        checked_count: 0,
        ignored_checks: [],
        failed_required: [],
        pending_required: [],
        conclusions: [],
      },
    };
  }

  const ignoredSet = new Set(options.ignoreCheckNames ?? []);
  const ignoredChecks: string[] = [];
  const failedRequired: string[] = [];
  const pendingRequired: string[] = [];
  const conclusions: CiCheckConclusion[] = [];

  for (const run of checkRuns) {
    const ignored = ignoredSet.has(run.name);
    if (ignored) {
      ignoredChecks.push(run.name);
    }

    const required = !ignored;
    conclusions.push({
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      required,
      ignored,
    });

    if (!required) {
      continue;
    }

    if (FAILED_CONCLUSIONS.has(run.conclusion)) {
      failedRequired.push(`${run.name} (${run.conclusion})`);
      continue;
    }

    if (isPending(run.status, run.conclusion)) {
      pendingRequired.push(`${run.name} (${run.status})`);
    }
  }

  const failures: string[] = [];
  if (failedRequired.length > 0) {
    failures.push(
      `Required CI check-runs failed: ${failedRequired.join(", ")}. ` +
        "Required checks fail closed by default (#2169).",
    );
  }
  if (pendingRequired.length > 0) {
    failures.push(
      `Required CI check-runs still running (not-ready-yet): ${pendingRequired.join(", ")}. ` +
        "Wait for required checks to finish before merge.",
    );
  }

  const readyState: CiReadyState =
    failedRequired.length > 0 ? "blocked" : pendingRequired.length > 0 ? "not_ready_yet" : "ready";

  return {
    failures,
    summary: {
      ready_state: readyState,
      checked_count: conclusions.filter((item) => item.required).length,
      ignored_checks: ignoredChecks,
      failed_required: failedRequired,
      pending_required: pendingRequired,
      conclusions,
    },
  };
}
