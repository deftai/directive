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
/** Non-blocking completed conclusions for general ready/pending accounting. */
const SUCCESS_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
/**
 * Only true success clears a cancelled suite lane. `skipped` / `neutral` are
 * not executed green failover evidence (#3167 Greptile P1).
 */
const AUTHORITATIVE_CLEAR_CONCLUSIONS = new Set(["success"]);

/**
 * Bot-reviewer check-runs are not CI workflow jobs. Presence of only these
 * (or empty check-runs) is the `ci_never_scheduled` weather signal (#3167).
 */
export function isBotReviewCheck(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes("greptile") || n.includes("slizard") || n.includes("coderabbit");
}

/**
 * Suite family for cancelled↔green sibling matching (#3167 / Greptile P1).
 * Unrelated greens (CodeQL, Socket, …) must not clear a cancelled TypeScript/Go lane.
 * Returns null when the check is not a TS/Go CI suite job.
 */
export function suiteFamilyOf(name: string): "typescript" | "go" | null {
  const n = name.toLowerCase();
  if (n.includes("typescript") || n.includes("type script")) {
    return "typescript";
  }
  // "Go (…)" primary/failover/aggregator; avoid bare "go" false positives (e.g. CodeQL go analyze).
  if (/\bgo\s*\(/.test(n) || n.startsWith("go ") || n === "go") {
    return "go";
  }
  return null;
}

/**
 * Branch-protection SoT aggregators only (#3168 map). Primary/failover lanes are
 * not authoritative: a green primary must not clear a cancelled aggregator.
 */
export function isAuthoritativeSuiteAggregator(name: string): boolean {
  const n = name.toLowerCase().trim();
  if (n.includes("primary") || n.includes("failover") || n.includes("blacksmith")) {
    return false;
  }
  if (n === "typescript (build + lint + test)") {
    return true;
  }
  if (n === "go (test + build)") {
    return true;
  }
  // Tolerate minor naming drift while excluding lane suffixes.
  if (
    suiteFamilyOf(name) === "typescript" &&
    n.includes("build") &&
    n.includes("lint") &&
    n.includes("test")
  ) {
    return true;
  }
  if (suiteFamilyOf(name) === "go" && n.includes("test") && n.includes("build")) {
    return true;
  }
  return false;
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
  } else if (cancelledRequired.length > 0) {
    // Cancelled suite jobs clear only when a NON-IGNORED AUTHORITATIVE aggregator
    // for that suite family is green (#3167 Greptile P1s):
    // - Unrelated greens (CodeQL, Socket) never clear
    // - Green primary/failover never clear a cancelled aggregator
    // - Operator-ignored aggregator never clears
    // - Green aggregator clears cancelled primary/failover (failover path done)
    // - Non-suite required cancellations always block (mixed cancel)
    // Strip trailing " (conclusion)" without nested-paren regex (CodeQL js/polynomial-redos).
    const stripConclusionParen = (label: string): string => {
      const open = label.lastIndexOf(" (");
      if (open < 0 || !label.endsWith(")")) {
        return label;
      }
      return label.slice(0, open);
    };

    const cancelledNonSuite = cancelledRequired.filter(
      (label) => suiteFamilyOf(stripConclusionParen(label)) === null,
    );
    const cancelledFamilies = new Set(
      cancelledRequired
        .map((label) => suiteFamilyOf(stripConclusionParen(label)))
        .filter((f): f is "typescript" | "go" => f !== null),
    );
    const greenAuthoritativeFamilies = new Set(
      conclusions
        .filter(
          (c) =>
            c.required &&
            !c.ignored &&
            c.status === "completed" &&
            AUTHORITATIVE_CLEAR_CONCLUSIONS.has(c.conclusion) &&
            isAuthoritativeSuiteAggregator(c.name),
        )
        .map((c) => suiteFamilyOf(c.name) as "typescript" | "go"),
    );
    const unclearedFamilies = [...cancelledFamilies].filter(
      (f) => !greenAuthoritativeFamilies.has(f),
    );

    if (unclearedFamilies.length > 0 || cancelledNonSuite.length > 0) {
      readyState = "ci_cancelled_no_failover";
      failedRequired = [...cancelledRequired];
      failures.push(
        `Required CI check-runs cancelled without failover (ci_cancelled_no_failover): ` +
          `${cancelledRequired.join(", ")}. ` +
          "Cancelled required check with no green non-ignored authoritative suite aggregator (#3167 / #3168). " +
          "Do not multi-hour re-push thrash; BLOCKED after thrash caps.",
      );
    } else {
      // Every cancelled suite family has a green non-ignored aggregator; no non-suite cancels.
      readyState = "ready";
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
      cancelled_required: cancelledRequired,
      conclusions,
    },
  };
}
