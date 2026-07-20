import type { CheckRunRecord } from "./gh.js";
import {
  type CapacityStallOptions,
  classifyCapacityStalledRequired,
  DEFAULT_CAPACITY_STALL_MS,
} from "./runner-capacity-stall.js";

const FAILED_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out"]);
const PENDING_STATUSES = new Set(["queued", "in_progress"]);

export type CiReadyState =
  | "ready"
  | "blocked"
  | "not_ready_yet"
  | "runner_capacity_stall"
  | "skipped";

export interface CiGateOptions {
  readonly skipCi?: boolean;
  readonly ignoreCheckNames?: readonly string[];
  /** Stall budget for runner_capacity_stall (#2672); default 20 minutes. */
  readonly capacityStallBudgetMs?: number;
  /** Injectable clock for capacity-stall tests. */
  readonly nowMs?: number;
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
  /** Required checks classified as capacity-stalled (#2672). */
  readonly capacity_stalled_required: readonly string[];
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
  const stallSuffix =
    summary.capacity_stalled_required.length > 0
      ? ` / ${summary.capacity_stalled_required.length} capacity-stalled`
      : "";
  return (
    `CI check-runs: ${passed} passed / ` +
    `${summary.failed_required.length} failed / ${summary.pending_required.length} pending` +
    stallSuffix
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
        capacity_stalled_required: [],
        conclusions: [],
      },
    };
  }

  const ignoredSet = new Set(options.ignoreCheckNames ?? []);
  const ignoredChecks: string[] = [];
  const failedRequired: string[] = [];
  const pendingRequired: string[] = [];
  const pendingProbes: CheckRunRecord[] = [];
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
      pendingProbes.push(run);
    }
  }

  const stallOpts: CapacityStallOptions = {
    budgetMs: options.capacityStallBudgetMs ?? DEFAULT_CAPACITY_STALL_MS,
    nowMs: options.nowMs,
  };
  const capacityStalledRequired = classifyCapacityStalledRequired(pendingProbes, stallOpts);

  const failures: string[] = [];
  if (failedRequired.length > 0) {
    failures.push(
      `Required CI check-runs failed: ${failedRequired.join(", ")}. ` +
        "Required checks fail closed by default (#2169).",
    );
  }

  let readyState: CiReadyState;
  if (failedRequired.length > 0) {
    readyState = "blocked";
  } else if (pendingRequired.length > 0) {
    // Capacity stall when every pending required check is a queue stall past
    // budget — distinct from ordinary not_ready_yet (under budget / in_progress).
    const allPendingStalled =
      capacityStalledRequired.length > 0 && capacityStalledRequired.length === pendingProbes.length;
    if (allPendingStalled) {
      readyState = "runner_capacity_stall";
      failures.push(
        `Required CI check-runs capacity-stalled (runner_capacity_stall): ` +
          `${capacityStalledRequired.join(", ")}. ` +
          "Queued past the stall budget with no runner claimed (#2672). " +
          "Wait for auto-failover to the GH-hosted lane; do NOT use --skip-ci.",
      );
    } else {
      readyState = "not_ready_yet";
      failures.push(
        `Required CI check-runs still running (not-ready-yet): ${pendingRequired.join(", ")}. ` +
          "Wait for required checks to finish before merge.",
      );
    }
  } else {
    readyState = "ready";
  }

  return {
    failures,
    summary: {
      ready_state: readyState,
      checked_count: conclusions.filter((item) => item.required).length,
      ignored_checks: ignoredChecks,
      failed_required: failedRequired,
      pending_required: pendingRequired,
      capacity_stalled_required: capacityStalledRequired,
      conclusions,
    },
  };
}
