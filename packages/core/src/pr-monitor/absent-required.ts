import { ABSENT_REQUIRED_GRACE_POLLS } from "./constants.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function ciFromPayload(payload: Record<string, unknown>): Record<string, unknown> | null {
  const partial = asRecord(payload.partial_data);
  if (partial === null) {
    return null;
  }
  return asRecord(partial.ci);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * Consume #3234 `ci_absent_required` from a readiness payload.
 * Returns missing context names, or null when the poll is not absent-required.
 * Pending required check-runs are a wait, not an absence.
 */
export function readAbsentRequiredContexts(
  payload: Record<string, unknown>,
): readonly string[] | null {
  const ci = ciFromPayload(payload);
  if (ci !== null) {
    const pending = stringList(ci.pending_required);
    if (pending.length > 0) {
      return null;
    }
    const readyState = ci.ready_state;
    if (readyState === "not_ready_yet") {
      return null;
    }
    if (readyState === "ci_absent_required") {
      return stringList(ci.absent_required);
    }
  }

  const failures = Array.isArray(payload.failures) ? payload.failures.map(String) : [];
  if (failures.some((failure) => failure.includes("ci_absent_required"))) {
    return [];
  }
  return null;
}

/** True once consecutive absent polls have passed the first-poll grace window. */
export function shouldEscalateAbsentRequired(
  consecutivePolls: number,
  gracePolls: number = ABSENT_REQUIRED_GRACE_POLLS,
): boolean {
  return consecutivePolls > gracePolls;
}

/** Distinct exit naming that lists the missing required contexts. */
export function formatAbsentRequiredMessage(contexts: readonly string[]): string {
  if (contexts.length === 0) {
    return "ABSENT-REQUIRED: required status-check context never appeared";
  }
  return `ABSENT-REQUIRED: ${contexts.join(", ")}`;
}
