/**
 * One lane + ingress verdict for both activation writers (#6264).
 *
 * `scope:activate` / `scope:promote` (`scope/transition.ts`) and
 * `xbrief:activate` / `vbrief:activate` (`vbrief-activate/activate.ts`) both
 * move a brief toward active/. Both call this helper, so the same brief gets
 * the same small-change lane verdict (#6204) and the same #4768 active-ingress
 * verdict from either verb.
 *
 * Order:
 *   1. The lane gate runs first. When it applies and refuses, the helper
 *      returns the lane refusal and does not run ingress. The lane gate keeps
 *      its own crossing record (lane state `crossed` on the brief file); that
 *      is the only write here, and it happens before any activation move or
 *      ingress restamp.
 *   2. `laneAdmitsThin` holds when the lane applies, admits, and the brief
 *      still has the thin command-backed acceptance shape. It waives the #4768
 *      clause refusals: the ingress refusal below, and the zero-clause
 *      derivation refusal in `scope/transition.ts`, which reads this field.
 *   3. When asked, the #4768 ingress check runs. It may stamp usable clauses on
 *      `plan.acceptance` in memory (`applied`); the caller persists them.
 *
 * The other writer splits (D7 filename, zero-clause derivation, clause
 * file_scope bind, #3334 acceptance-activate gate) stay outside this helper.
 */

import { checkCommandBackedAcceptance } from "../intake/thin-brief.js";
import {
  evaluateSmallChangeLaneGate,
  type SmallChangeLaneGateName,
  type SmallChangeLaneGateOverrides,
  type SmallChangeLaneGateResult,
} from "../policy/small-change-lane.js";
import {
  type ActiveIngressAcceptanceResult,
  prepareActiveIngressAcceptance,
} from "./acceptance-activate-gate.js";

/** Success notice when the lane waives the #4768 ingress refusal. */
export const LANE_INGRESS_WAIVER_NOTICE =
  "[deft small-change-lane] #4768 clause refusal waived: the lane admits this thin " +
  "command-backed brief (#6204)";

export interface LaneIngressGateOptions {
  readonly projectRoot: string;
  /** Verb named in a lane refusal. */
  readonly gate: SmallChangeLaneGateName;
  /** Brief file; a lane crossing is recorded on it. */
  readonly briefPath: string;
  /** Run the #4768 active-ingress check after the lane verdict. */
  readonly ingress: boolean;
  /** Test and caller overrides for the lane gate. Production callers pass none. */
  readonly smallChangeLane?: SmallChangeLaneGateOverrides;
}

export interface LaneIngressGateResult {
  /** False when the lane or the ingress check refuses. */
  readonly ok: boolean;
  /** The refusal text, or on success the ingress or waiver notice (may be empty). */
  readonly message: string;
  /** Which verdict refused; null when ok. */
  readonly refusedBy: "lane" | "ingress" | null;
  /** Lane verdict. `applies` is false for a brief with no lane marker. */
  readonly lane: SmallChangeLaneGateResult;
  /** The lane admits a thin command-backed brief: the #4768 clause refusals are waived. */
  readonly laneAdmitsThin: boolean;
  /** Ingress verdict before the waiver; null when not requested or the lane refused. */
  readonly ingress: ActiveIngressAcceptanceResult | null;
  /** True when the ingress check stamped usable clauses on plan.acceptance (caller persists). */
  readonly applied: boolean;
}

/** Lane verdict, then the #4768 ingress verdict with the lane waiver applied. */
export function evaluateLaneIngressGate(
  plan: Record<string, unknown>,
  options: LaneIngressGateOptions,
): LaneIngressGateResult {
  const lane = evaluateSmallChangeLaneGate(plan, {
    ...options.smallChangeLane,
    projectRoot: options.projectRoot,
    gate: options.gate,
    briefPath: options.briefPath,
  });
  if (lane.applies && !lane.ok) {
    return {
      ok: false,
      message: lane.message,
      refusedBy: "lane",
      lane,
      laneAdmitsThin: false,
      ingress: null,
      applied: false,
    };
  }
  // A lane brief carries stated commands and no clauses by design: while the
  // lane admits it, the clause refusals (#4768) do not apply to it.
  const laneAdmitsThin =
    lane.applies &&
    lane.ok &&
    lane.verdict?.kind === "admitted" &&
    checkCommandBackedAcceptance(plan.acceptance).ok;
  if (!options.ingress) {
    return {
      ok: true,
      message: "",
      refusedBy: null,
      lane,
      laneAdmitsThin,
      ingress: null,
      applied: false,
    };
  }
  const ingress = prepareActiveIngressAcceptance(plan, { projectRoot: options.projectRoot });
  if (ingress.ok) {
    return {
      ok: true,
      message: ingress.message,
      refusedBy: null,
      lane,
      laneAdmitsThin,
      ingress,
      applied: ingress.applied,
    };
  }
  if (laneAdmitsThin) {
    return {
      ok: true,
      message: LANE_INGRESS_WAIVER_NOTICE,
      refusedBy: null,
      lane,
      laneAdmitsThin,
      ingress,
      applied: false,
    };
  }
  return {
    ok: false,
    message: ingress.message,
    refusedBy: "ingress",
    lane,
    laneAdmitsThin,
    ingress,
    applied: false,
  };
}
