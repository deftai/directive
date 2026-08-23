import {
  CRITIQUE_RECOMMEND_FIELD,
  type GithubIssueSnapshot,
  RESERVED_CLEARANCE_RE,
  type ValueAdvice,
} from "./types.js";

export class ReservedClearanceError extends Error {
  override name = "ReservedClearanceError";
}

export function assertNoReservedClearance(text: string, label: string): void {
  if (RESERVED_CLEARANCE_RE.test(text)) {
    throw new ReservedClearanceError(
      `${label} must not emit the reserved clearance line ` +
        "`design-critique: warranted | not warranted, because …`",
    );
  }
}

/**
 * Value MAY recommend critique via `critique-recommend:`.
 * It MUST NOT stamp the reserved ADR-005 clearance grammar.
 */
export function buildValueAdvice(issue: GithubIssueSnapshot | null): ValueAdvice {
  const labels = issue?.labels ?? [];
  const stamped = labels.some((label) => label === "design-critique:mechanism-shaped");
  const reason = stamped
    ? "GitHub label design-critique:mechanism-shaped is present; author still stamps clearance"
    : "no mechanism-shaped stamp; critique not recommended from evaluation";
  const advice: ValueAdvice = {
    [CRITIQUE_RECOMMEND_FIELD]: stamped,
    reason,
  };
  assertNoReservedClearance(JSON.stringify(advice), "value advice");
  return advice;
}

export function formatValueField(advice: ValueAdvice): string {
  const line = `${CRITIQUE_RECOMMEND_FIELD}: ${advice[CRITIQUE_RECOMMEND_FIELD] ? "true" : "false"}`;
  assertNoReservedClearance(`${line}\n${advice.reason}`, "value field");
  return `${line}\n${advice.reason}`;
}
