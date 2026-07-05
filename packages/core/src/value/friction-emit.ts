import { detectContradictoryGates } from "../eval/health.js";
import { recordFrictionSignal } from "../events/attribution-ledger.js";
import {
  isValueFeedbackPathAllowed,
  resolveValueFeedback,
  type ValueFeedbackResolved,
} from "../policy/value-feedback.js";

export interface FrictionEmitOptions {
  readonly logPath?: string | null;
  readonly policyOverride?: ValueFeedbackResolved;
}

/** Record friction signals for each contradictory gate detected by eval:health (#2339). */
export function recordFrictionFromContradictoryGates(
  projectRoot: string,
  options: FrictionEmitOptions = {},
): number {
  const policy = options.policyOverride ?? resolveValueFeedback(projectRoot);
  if (!isValueFeedbackPathAllowed("emitEvents", policy)) {
    return 0;
  }
  const contradictions = detectContradictoryGates(projectRoot);
  let recorded = 0;
  for (const contradiction of contradictions) {
    const record = recordFrictionSignal(
      projectRoot,
      "eval:health",
      `${contradiction.id}: ${contradiction.summary}`,
      { logPath: options.logPath, policyOverride: policy },
    );
    if (record !== null) {
      recorded += 1;
    }
  }
  return recorded;
}

/** Session/work-boundary friction probe alias (#2339). */
export function probeFrictionAtWorkBoundary(
  projectRoot: string,
  options: FrictionEmitOptions = {},
): number {
  return recordFrictionFromContradictoryGates(projectRoot, options);
}
