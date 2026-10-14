/**
 * Rapid product-first check exit when the acceptance walk reports zero
 * verified clauses (#4866), and the complete-side refuse-unless-executable-pass
 * overlay for the same print (#4870).
 *
 * verify:ac may still exit 0 on an unverifiable no-oracle walk (#3826).
 * These predicates do not change that. Rapid check reads only the #4866
 * path; scope:complete reads the #4870 overlay on the walk it consumes.
 *
 * #5477: waive #4866 for an in-diff completed walk under a
 * lifecycle-maintenance-only change set (leftover-complete / completing PR).
 * That walk already cleared #4870 to land in completed/.
 */
import { isProductAcGate } from "../product-first-done-gate/check-mode.js";
import {
  collectLifecycleChangeSet,
  evaluateLifecycleMaintenanceEligibility,
  type CollectedChangeSet,
} from "./session-completed-ac.js";

const CLAUSE_WALK_ZERO_VERIFIED =
  /verify:ac clause walk \(#3323\): 0 verified, \d+ unverifiable, \d+ failed/;

const PASS_LEAD_ZERO_VERIFIED =
  /verify:ac passed \(#3284\)(?: served_from=\S+)? \(0 verified, \d+ unverifiable\)/;

const JUST_COMPLETED_TARGET =
  /verify:ac targeting just-completed brief \(#3357\):\s*(\S+)/;

const EXECUTABLE_PASS_VERDICT =
  /acceptance verdict \(#3497\):\s*executable-pass\b/;

export const RAPID_ZERO_VERIFIED_CHECK_NOTICE =
  "check: rapid product-first acceptance walk reported 0 verified clauses; not exit 0 (#4866)\n";

export const SCOPE_COMPLETE_ZERO_VERIFIED_NOTICE =
  "scope:complete refused: acceptance walk reported 0 verified clauses without an executable-pass oracle (#4870)\n";

/** True when verify:ac text reports a walk with zero verified clauses. */
export function acceptanceWalkReportsZeroVerified(text: string): boolean {
  return CLAUSE_WALK_ZERO_VERIFIED.test(text) || PASS_LEAD_ZERO_VERIFIED.test(text);
}

/** Parse the #3357 just-completed target path from verify:ac text, if present. */
export function parseJustCompletedWalkTarget(text: string): string | null {
  const m = JUST_COMPLETED_TARGET.exec(text);
  const path = m?.[1]?.trim() ?? "";
  return path.length > 0 ? path : null;
}

/** True when verify:ac text names the #3497 executable-pass predicate. */
export function acceptanceTextReportsExecutablePass(text: string): boolean {
  return EXECUTABLE_PASS_VERDICT.test(text);
}

/**
 * Rapid check must not exit 0 for this gate output. Other modes, other
 * gates, and a walk that does not report zero verified stay false.
 *
 * #5477 item 3: when the walk targets an in-diff completed brief under a
 * lifecycle-maintenance-only change set, do not apply #4866 — that print
 * already cleared #4870 on the complete path (executable-pass or the
 * Bound's "already passed #4870" overlay for leftover/completing PRs).
 */
export function rapidCheckRejectsZeroVerifiedWalk(input: {
  readonly mode: string;
  readonly gateId: string;
  readonly text: string;
  readonly projectRoot?: string;
  readonly changeSet?: CollectedChangeSet | null;
  /** Injected overlay decision (tests). */
  readonly inDiffCompletedExecutablePass?: boolean;
}): boolean {
  if (
    !(
      input.mode === "rapid" &&
      isProductAcGate(input.gateId) &&
      acceptanceWalkReportsZeroVerified(input.text)
    )
  ) {
    return false;
  }

  if (input.inDiffCompletedExecutablePass === true) {
    return false;
  }

  const walkTarget = parseJustCompletedWalkTarget(input.text);
  const projectRoot = input.projectRoot?.trim() ?? "";
  if (walkTarget !== null && projectRoot.length > 0) {
    const changeSet =
      input.changeSet !== undefined && input.changeSet !== null
        ? input.changeSet
        : collectLifecycleChangeSet({ projectRoot });
    const decision = evaluateLifecycleMaintenanceEligibility({
      walkTargetAbsOrRel: walkTarget,
      projectRoot,
      changeSet,
    });
    if (decision.kind === "in-diff-completed-overlay") {
      return false;
    }
  }

  return true;
}

/**
 * scope:complete must not exit 0 on the #4866 zero-verified print unless a
 * green executable oracle already ran (predicate executable-pass). Evidence
 * markers and #3826 no-oracle alone are not enough (#4870). verify:ac stays
 * unreverted.
 */
export function scopeCompleteRejectsZeroVerifiedWalk(input: {
  readonly text: string;
  readonly predicate: string;
}): boolean {
  return acceptanceWalkReportsZeroVerified(input.text) && input.predicate !== "executable-pass";
}
