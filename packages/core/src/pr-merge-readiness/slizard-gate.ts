import type { CheckRunRecord } from "./gh.js";

/**
 * Dedicated gate for the SLizard second-reviewer verdict (#2189).
 *
 * SLizard posts a check-run whose `output.summary` carries a structured verdict:
 *
 *   Decision: request_changes
 *   Merge impact: blocking
 *   Findings: 2 (P0: 0, P1: 1, P2: 0, P3: 0)
 *
 * The generic CI check-run gate (#2169) only fails closed on a check-run
 * `conclusion` in the failed set, so a blocking *decision* carried on a
 * non-`failure` conclusion (e.g. `neutral`) would slip through and the review
 * is surfaced indistinctly among build/test checks. This gate parses the
 * structured verdict and fails merge-readiness on a blocking decision.
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

function firstMatch(text: string, re: RegExp): string | null {
  const m = re.exec(text);
  return m?.[1] !== undefined ? m[1].trim() : null;
}

function countFor(text: string, sev: "P0" | "P1" | "P2"): number | null {
  const m = new RegExp(`${sev}\\s*:\\s*(\\d+)`, "i").exec(text);
  return m?.[1] !== undefined ? Number.parseInt(m[1], 10) : null;
}

/** Parse a SLizard check-run `output.summary` into a structured verdict. */
export function parseSlizardVerdict(summary: string | undefined | null): SlizardVerdict {
  const text = summary ?? "";
  const decision = firstMatch(text, /Decision\s*:\s*([A-Za-z_]+)/i);
  const mergeImpact = firstMatch(text, /Merge impact\s*:\s*([A-Za-z_-]+)/i);
  return {
    decision: decision ? decision.toLowerCase() : null,
    mergeImpact: mergeImpact ? mergeImpact.toLowerCase() : null,
    p0Count: countFor(text, "P0"),
    p1Count: countFor(text, "P1"),
    p2Count: countFor(text, "P2"),
  };
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

  const verdict = parseSlizardVerdict(run.summary);
  const blockingDecision = verdict.decision !== null && BLOCKING_DECISIONS.has(verdict.decision);
  const blockingImpact = verdict.mergeImpact === "blocking";
  const failedConclusion = FAILED_CONCLUSIONS.has(run.conclusion);

  const failures: string[] = [];
  let readyState: SlizardReadyState;

  if (blockingDecision || blockingImpact || failedConclusion) {
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
