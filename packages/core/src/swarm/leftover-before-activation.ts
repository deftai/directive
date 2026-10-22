/**
 * Thin leftover-before-activation refuse (#5736 Prefer-A Recut-1 P4).
 * At cohort activation prepare/open, refuse when the preceding cohort
 * leftover-complete land is still outstanding (open/unmerged). Cohort-specific
 * only — no global lifecycle lock.
 */

export type LeftoverLandEvidence = {
  /** Open leftover-complete / lifecycle closer PR numbers still unmerged. */
  readonly openLeftoverPrNumbers: readonly number[];
  /** Optional human label for the cohort (allocation_plan_id / conflict_group). */
  readonly cohortId?: string;
};

export type LeftoverBeforeActivationResult =
  | { readonly ok: true; readonly detail: string }
  | {
      readonly ok: false;
      readonly reason: "outstanding-leftover-land";
      readonly detail: string;
      readonly openLeftoverPrNumbers: readonly number[];
    };

/**
 * Refuse activation prepare/open when leftover-complete lands for this cohort
 * are still open. Cleared leftover (empty open set) admits.
 */
export function evaluateLeftoverBeforeActivation(
  evidence: LeftoverLandEvidence,
): LeftoverBeforeActivationResult {
  const open = evidence.openLeftoverPrNumbers.filter((n) => Number.isInteger(n) && n > 0);
  if (open.length === 0) {
    return {
      ok: true,
      detail: "leftover-before-activation clear: no outstanding leftover-complete land",
    };
  }
  const cohort =
    typeof evidence.cohortId === "string" && evidence.cohortId.trim().length > 0
      ? ` for cohort ${evidence.cohortId.trim()}`
      : "";
  return {
    ok: false,
    reason: "outstanding-leftover-land",
    openLeftoverPrNumbers: open,
    detail:
      `leftover-before-activation refuse (#5736): outstanding leftover-complete land` +
      `${cohort}: open PR(s) ${open.map((n) => `#${String(n)}`).join(", ")}. ` +
      `Land leftover first, then fetch/refresh the activation base before prepare/open.`,
  };
}
