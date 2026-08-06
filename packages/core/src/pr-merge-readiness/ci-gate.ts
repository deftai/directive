import type { CheckRunRecord } from "./gh.js";
import {
  type CapacityStallOptions,
  classifyCapacityStalledRequired,
  DEFAULT_CAPACITY_STALL_MS,
} from "./runner-capacity-stall.js";

/** Real product/test failures (distinct from cancelled primaries, #3167). */
const FAILURE_CONCLUSIONS = new Set(["failure", "timed_out"]);
/** Capacity/outage cancels where failover may have been skipped (#3167). */
const CANCELLED_CONCLUSIONS = new Set(["cancelled"]);
const PENDING_STATUSES = new Set(["queued", "in_progress"]);
const SUCCESS_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/**
 * Bot-reviewer check-runs are not CI workflow jobs. Presence of only these
 * (or empty check-runs) is the `ci_never_scheduled` weather signal (#3167).
 */
export function isBotReviewCheck(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes("greptile") || n.includes("slizard") || n.includes("coderabbit");
}

export type CiReadyState =
  | "ready"
  | "blocked"
  | "ci_failures"
  | "not_ready_yet"
  | "runner_capacity_stall"
  | "ci_never_scheduled"
  | "ci_cancelled_no_failover"
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
  /** Required checks cancelled without a green failover sibling (#3167). */
  readonly cancelled_required: readonly string[];
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

function emptySummary(readyState: CiReadyState, ignored: readonly string[] = []): CiGateSummary {
  return {
    ready_state: readyState,
    checked_count: 0,
    ignored_checks: ignored,
    failed_required: [],
    pending_required: [],
    capacity_stalled_required: [],
    cancelled_required: [],
    conclusions: [],
  };
}

export function buildCiSummaryLine(summary: CiGateSummary): string {
  const passed =
    summary.checked_count - summary.failed_required.length - summary.pending_required.length;
  const stallSuffix =
    summary.capacity_stalled_required.length > 0
      ? ` / ${summary.capacity_stalled_required.length} capacity-stalled`
      : "";
  const cancelSuffix =
    summary.cancelled_required.length > 0
      ? ` / ${summary.cancelled_required.length} cancelled`
      : "";
  const weather =
    summary.ready_state === "ci_never_scheduled"
      ? " (ci_never_scheduled)"
      : summary.ready_state === "ci_cancelled_no_failover"
        ? " (ci_cancelled_no_failover)"
        : summary.ready_state === "ci_failures"
          ? " (ci_failures)"
          : "";
  return (
    `CI check-runs: ${passed} passed / ` +
    `${summary.failed_required.length} failed / ${summary.pending_required.length} pending` +
    stallSuffix +
    cancelSuffix +
    weather
  );
}

/**
 * Classify required CI weather for a HEAD check-run list (#2169 / #2672 / #3167).
 *
 * Distinct ready_state codes:
 * - `ci_never_scheduled` — no CI workflow check-runs (bots alone / empty)
 * - `runner_capacity_stall` — queued past budget, no runner claimed
 * - `ci_failures` — completed failure / timed_out with product evidence
 * - `ci_cancelled_no_failover` — only cancelled failures; no green failover
 * - `not_ready_yet` / `ready` / `blocked` / `skipped` — legacy + residual
 */
export function evaluateCiGate(
  checkRuns: readonly CheckRunRecord[],
  options: CiGateOptions = {},
): CiGateResult {
  if (options.skipCi === true) {
    return {
      failures: [],
      summary: emptySummary("skipped"),
    };
  }

  const ignoredSet = new Set(options.ignoreCheckNames ?? []);
  const ignoredChecks: string[] = [];
  const failedProduct: string[] = [];
  const cancelledRequired: string[] = [];
  const pendingRequired: string[] = [];
  const pendingProbes: CheckRunRecord[] = [];
  const conclusions: CiCheckConclusion[] = [];
  let workflowCheckCount = 0;
  let successCount = 0;
  let operatorIgnoredOnly = false;

  for (const run of checkRuns) {
    const botReview = isBotReviewCheck(run.name);
    const operatorIgnored = ignoredSet.has(run.name);
    const ignored = operatorIgnored || botReview;
    if (operatorIgnored) {
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

    workflowCheckCount += 1;

    if (run.status === "completed" && SUCCESS_CONCLUSIONS.has(run.conclusion)) {
      successCount += 1;
      continue;
    }

    if (FAILURE_CONCLUSIONS.has(run.conclusion)) {
      failedProduct.push(`${run.name} (${run.conclusion})`);
      continue;
    }

    if (CANCELLED_CONCLUSIONS.has(run.conclusion)) {
      cancelledRequired.push(`${run.name} (${run.conclusion})`);
      continue;
    }

    if (isPending(run.status, run.conclusion)) {
      pendingRequired.push(`${run.name} (${run.status})`);
      pendingProbes.push(run);
    }
  }

  // Operator --ci-ignore-check on every non-bot run is intentional, not weather.
  operatorIgnoredOnly =
    workflowCheckCount === 0 &&
    checkRuns.some((r) => ignoredSet.has(r.name) && !isBotReviewCheck(r.name));

  // #3167: no workflow CI check-runs at all (empty list or bots-only) → never scheduled.
  // Distinct from "all remaining checks operator-ignored" (legacy ready).
  if (workflowCheckCount === 0 && !operatorIgnoredOnly) {
    return {
      failures: [
        "Required CI workflow check-runs never scheduled (ci_never_scheduled): " +
          "no non-bot check-run for the current HEAD. " +
          "Do not multi-hour empty-commit thrash; emit BLOCKED after thrash caps (#3167).",
      ],
      summary: {
        ready_state: "ci_never_scheduled",
        checked_count: 0,
        ignored_checks: ignoredChecks,
        failed_required: [],
        pending_required: [],
        capacity_stalled_required: [],
        cancelled_required: [],
        conclusions,
      },
    };
  }

  const stallOpts: CapacityStallOptions = {
    budgetMs: options.capacityStallBudgetMs ?? DEFAULT_CAPACITY_STALL_MS,
    nowMs: options.nowMs,
  };
  const capacityStalledRequired = classifyCapacityStalledRequired(pendingProbes, stallOpts);

  const failures: string[] = [];
  let readyState: CiReadyState;
  // Blocking failures listed for merge-ready / clean-gate (not diagnostic-only cancels).
  let failedRequired: string[] = [];

  if (failedProduct.length > 0) {
    readyState = "ci_failures";
    failedRequired = [...failedProduct, ...cancelledRequired];
    failures.push(
      `Required CI check-runs failed (ci_failures): ${failedProduct.join(", ")}. ` +
        "Required checks fail closed by default (#2169 / #3167).",
    );
  } else if (pendingRequired.length > 0) {
    // Pending wins over cancelled siblings (failover may still be arming).
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
  } else if (cancelledRequired.length > 0 && successCount === 0) {
    // Cancelled lanes with no green required sibling = failover skipped/not armed (#3167).
    readyState = "ci_cancelled_no_failover";
    failedRequired = [...cancelledRequired];
    failures.push(
      `Required CI check-runs cancelled without failover (ci_cancelled_no_failover): ` +
        `${cancelledRequired.join(", ")}. ` +
        "Primary cancelled and no green required sibling (#3167 / #3168). " +
        "Do not multi-hour re-push thrash; BLOCKED after thrash caps.",
    );
  } else {
    // successCount > 0 with optional cancelled siblings (replaced primary) → ready.
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
      cancelled_required: cancelledRequired,
      conclusions,
    },
  };
}
