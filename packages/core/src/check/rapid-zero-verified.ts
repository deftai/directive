/**
 * Rapid product-first check exit when the acceptance walk reports zero
 * verified clauses (#4866).
 *
 * verify:ac may still exit 0 on an unverifiable no-oracle walk (#3826).
 * This predicate does not change that. It also does not put other gates
 * back on the rapid list. The check orchestrator reads it only in rapid mode.
 */
import { isProductAcGate } from "../product-first-done-gate/check-mode.js";

const CLAUSE_WALK_ZERO_VERIFIED =
  /verify:ac clause walk \(#3323\): 0 verified, \d+ unverifiable, \d+ failed/;

const PASS_LEAD_ZERO_VERIFIED =
  /verify:ac passed \(#3284\)(?: served_from=\S+)? \(0 verified, \d+ unverifiable\)/;

export const RAPID_ZERO_VERIFIED_CHECK_NOTICE =
  "check: rapid product-first acceptance walk reported 0 verified clauses; not exit 0 (#4866)\n";

/** True when verify:ac text reports a walk with zero verified clauses. */
export function acceptanceWalkReportsZeroVerified(text: string): boolean {
  return CLAUSE_WALK_ZERO_VERIFIED.test(text) || PASS_LEAD_ZERO_VERIFIED.test(text);
}

/**
 * Rapid check must not exit 0 for this gate output. Other modes, other
 * gates, and a walk that does not report zero verified stay false.
 */
export function rapidCheckRejectsZeroVerifiedWalk(input: {
  readonly mode: string;
  readonly gateId: string;
  readonly text: string;
}): boolean {
  return (
    input.mode === "rapid" &&
    isProductAcGate(input.gateId) &&
    acceptanceWalkReportsZeroVerified(input.text)
  );
}
