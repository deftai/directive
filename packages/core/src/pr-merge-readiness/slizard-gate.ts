import {
  parseSlizardCheckRunSummary,
  type SlizardCheckRunVerdict,
  slizardCheckRunHasZeroFindings,
} from "../content-contracts/skills/greptile-detector.js";
import type { CheckRunRecord } from "./gh.js";

/**
 * Dedicated gate for the SLizard second-reviewer verdict (#2189 / #4387).
 *
 * SLizard posts a check-run whose `output.summary` looks like (live capture
 * `deftai/bs-deepwordle#4` SHA a8a20f3):
 *
 *   **Decision**: request_changes
 *   **Merge impact**: blocking
 *   **Findings**: 1 actionable, 5 advisory
 *   **Severity counts**: P0: 0, P1: 1, P2: 0, P3: 0
 *
 * Parse goes through `parseSlizardCheckRunSummary` in greptile-detector.ts
 * (same module as the canonical review-body detector; `detect()` is the wrong
 * function for this surface). Finding-count lands with parse repair: a parsed
 * `request_changes` / `merge_impact=blocking` / `conclusion=failure` is
 * merge-blocking only when the same summary is not zero-finding.
 *
 * Policy (#4387 Bound-remedy): `conclusion=failure` plus zero findings on the
 * check-run summary is advisory, not a block. Crash/timeout/cancelled with no
 * parseable zero-finding verdict still block. The HTML `slizard:verdict` block
 * is not on the live check-run; it lives on the PR review body. This gate does
 * not fetch reviews.
 */

/** Canonical SLizard check-run name; matching is case-insensitive substring for resilience. */
export const SLIZARD_CHECK_NAME = "SLizard";

const FAILED_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out"]);
const PENDING_STATUSES = new Set(["queued", "in_progress"]);
const BLOCKING_DECISIONS = new Set(["request_changes", "changes_requested", "reject"]);

export type SlizardReadyState = "ready" | "blocked" | "not_ready_yet" | "skipped";

export interface SlizardGateOptions {
  readonly skipSlizard?: boolean;
}

export interface SlizardVerdict {
  readonly decision: string | null;
  readonly mergeImpact: string | null;
  readonly findingCount: number | null;
  readonly p0Count: number | null;
  readonly p1Count: number | null;
  readonly p2Count: number | null;
}

export interface SlizardGateSummary {
  readonly ready_state: SlizardReadyState;
  readonly present: boolean;
  readonly check_name: string | null;
  readonly status: string | null;
  readonly conclusion: string | null;
  readonly verdict: SlizardVerdict | null;
  readonly summary_line: string;
}

export interface SlizardGateResult {
  readonly failures: readonly string[];
  readonly summary: SlizardGateSummary;
}

export function isSlizardCheck(name: string): boolean {
  return name.toLowerCase().includes("slizard");
}

function toSlizardVerdict(parsed: SlizardCheckRunVerdict): SlizardVerdict {
  return {
    decision: parsed.decision,
    mergeImpact: parsed.mergeImpact,
    findingCount: parsed.findingCount,
    p0Count: parsed.p0Count,
    p1Count: parsed.p1Count,
    p2Count: parsed.p2Count,
  };
}

/** Parse a SLizard check-run `output.summary` into a structured verdict. */
export function parseSlizardVerdict(summary: string | undefined | null): SlizardVerdict {
  return toSlizardVerdict(parseSlizardCheckRunSummary(summary));
}

function skippedSummary(reason: string): SlizardGateSummary {
  return {
    ready_state: "skipped",
    present: false,
    check_name: null,
    status: null,
    conclusion: null,
    verdict: null,
    summary_line: `SLizard review: skipped (${reason})`,
  };
}

function isPending(status: string, conclusion: string): boolean {
  if (PENDING_STATUSES.has(status)) {
    return true;
  }
  return status !== "completed" || conclusion === "none";
}

export function evaluateSlizardGate(
  checkRuns: readonly CheckRunRecord[],
  options: SlizardGateOptions = {},
): SlizardGateResult {
  if (options.skipSlizard === true) {
    return { failures: [], summary: skippedSummary("--skip-slizard") };
  }

  const run = checkRuns.find((r) => isSlizardCheck(r.name));
  if (run === undefined) {
    // SLizard is an optional second reviewer; its absence does not block merge.
    return { failures: [], summary: skippedSummary("no SLizard check-run on this commit") };
  }

  const parsed = parseSlizardCheckRunSummary(run.summary);
  const verdict = toSlizardVerdict(parsed);
  const zeroFindings = slizardCheckRunHasZeroFindings(parsed);
  const blockingDecision = verdict.decision !== null && BLOCKING_DECISIONS.has(verdict.decision);
  const blockingImpact = verdict.mergeImpact === "blocking";
  const failedConclusion = FAILED_CONCLUSIONS.has(run.conclusion);
  const wouldBlock = blockingDecision || blockingImpact || failedConclusion;

  const failures: string[] = [];
  let readyState: SlizardReadyState;

  if (wouldBlock && !zeroFindings) {
    readyState = "blocked";
    const reasons: string[] = [];
    if (verdict.decision !== null) {
      reasons.push(`decision=${verdict.decision}`);
    }
    if (verdict.mergeImpact !== null) {
      reasons.push(`merge impact=${verdict.mergeImpact}`);
    }
    if (failedConclusion) {
      reasons.push(`conclusion=${run.conclusion}`);
    }
    const findings =
      verdict.p0Count !== null || verdict.p1Count !== null || verdict.p2Count !== null
        ? ` (P0=${verdict.p0Count ?? 0} P1=${verdict.p1Count ?? 0} P2=${verdict.p2Count ?? 0})`
        : "";
    failures.push(
      `SLizard review is blocking: ${reasons.join(", ")}${findings}. ` +
        "Resolve the SLizard findings or pass --skip-slizard to override (#2189).",
    );
  } else if (isPending(run.status, run.conclusion)) {
    readyState = "not_ready_yet";
    failures.push(
      `SLizard review still in progress (${run.status}); wait for the verdict before merge (#2189).`,
    );
  } else {
    readyState = "ready";
  }

  const parts: string[] = [
    `decision=${verdict.decision ?? "?"}`,
    `impact=${verdict.mergeImpact ?? "?"}`,
  ];
  if (zeroFindings && wouldBlock) {
    parts.push("findings=0", "advisory");
  }
  return {
    failures,
    summary: {
      ready_state: readyState,
      present: true,
      check_name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      verdict,
      summary_line: `SLizard review: ${readyState} (${parts.join(", ")})`,
    },
  };
}
