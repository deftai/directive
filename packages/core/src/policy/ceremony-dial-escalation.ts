/**
 * Ceremony-dial escalation evaluation + start-tier provenance (#3319).
 *
 * Observability only: does not change escalate-on-evidence thresholds or the
 * default start tier. A declined evaluation is distinct from never-evaluated.
 */

import { RunSummaryEmitter } from "../run-summary/emit.js";
import type { DialEscalationEvaluationOutcome } from "../run-summary/types.js";
import {
  type CeremonyDepth,
  type CeremonyDialInputs,
  type CeremonyDialSelection,
  type CeremonyModelTier,
  selectCeremonyColdStartDepth,
} from "./ceremony-dial.js";

export const CEREMONY_START_TIER_PROVENANCES = ["cold-start", "external-pin", "operator"] as const;
export type CeremonyStartTierProvenance = (typeof CEREMONY_START_TIER_PROVENANCES)[number];

export const CEREMONY_DEPTH_RANK: Readonly<Record<CeremonyDepth, number>> = {
  minimal: 0,
  rapid: 1,
  standard: 2,
  elevated: 3,
};

export interface ResolveCeremonyStartTierProvenanceInput {
  readonly selection: CeremonyDialSelection;
  /** True when session:start received a pre-resolved selection (CLI/harness). */
  readonly injectedSelection: boolean;
  readonly hint?: CeremonyStartTierProvenance;
}

export function resolveCeremonyStartTierProvenance(
  input: ResolveCeremonyStartTierProvenanceInput,
): CeremonyStartTierProvenance {
  if (input.hint !== undefined) {
    return input.hint;
  }
  if (input.selection.source === "override") {
    return input.injectedSelection ? "external-pin" : "operator";
  }
  return "cold-start";
}

export function isCeremonyStartTierPinned(provenance: CeremonyStartTierProvenance): boolean {
  return provenance === "external-pin" || provenance === "operator";
}

/** Session-start fail-closed line when a pin bypasses #3274 cold-start selection. */
export function formatCeremonyDialPinBypassLine(
  provenance: CeremonyStartTierProvenance,
): string | null {
  if (!isCeremonyStartTierPinned(provenance)) {
    return null;
  }
  const pinLabel = provenance === "external-pin" ? "external-pin" : "operator pin";
  return (
    `[deft ceremony-dial] #3274 cold-start selection is bypassed (${pinLabel}). ` +
    "Unset the pin (--ceremony-depth or plan.policy.ceremonyDial.override) to exercise #3274."
  );
}

export interface CeremonyDialEscalationEvaluation {
  readonly tier: CeremonyDepth;
  readonly outcome: DialEscalationEvaluationOutcome;
  readonly reason: string;
  readonly from: CeremonyDepth;
  readonly to: CeremonyDepth;
}

export interface EvaluateCeremonyDialEscalationInput {
  readonly from: CeremonyDepth;
  readonly to: CeremonyDepth;
  readonly inputs?: CeremonyDialInputs;
}

/**
 * Pure escalate-on-evidence evaluation. `to > from` → escalated; else declined.
 * Does not persist a transition.
 */
export function evaluateCeremonyDialEscalation(
  input: EvaluateCeremonyDialEscalationInput,
): CeremonyDialEscalationEvaluation {
  const size = input.inputs?.taskSize ?? null;
  const modelTier = input.inputs?.modelTier ?? null;
  const evidence = `size=${size ?? "-"} modelTier=${modelTier ?? "-"}`;
  const raised = CEREMONY_DEPTH_RANK[input.to] > CEREMONY_DEPTH_RANK[input.from];
  if (raised) {
    return {
      tier: input.to,
      outcome: "escalated",
      reason: `evidence raised ${input.from} -> ${input.to} (${evidence})`,
      from: input.from,
      to: input.to,
    };
  }
  return {
    tier: input.from,
    outcome: "declined",
    reason: `insufficient evidence to raise above ${input.from} (${evidence})`,
    from: input.from,
    to: input.to,
  };
}

/** Cold-start vs selected depth at session:start (unpinned path only). */
export function evaluateSessionStartCeremonyDialEscalation(input: {
  readonly selection: CeremonyDialSelection;
  readonly modelTier?: CeremonyModelTier | null;
}): CeremonyDialEscalationEvaluation {
  const modelTier = input.modelTier ?? input.selection.inputs.modelTier;
  const from = selectCeremonyColdStartDepth(modelTier);
  return evaluateCeremonyDialEscalation({
    from,
    to: input.selection.depth,
    inputs: input.selection.inputs,
  });
}

export interface EmitCeremonyDialEscalationEvaluationOptions {
  readonly projectRoot: string;
  readonly sessionId: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly evaluation: CeremonyDialEscalationEvaluation;
}

/** Fail-open emit of a #3319 evaluation event. */
export function emitCeremonyDialEscalationEvaluation(
  options: EmitCeremonyDialEscalationEvaluationOptions,
): void {
  try {
    const emitter = new RunSummaryEmitter({
      projectRoot: options.projectRoot,
      sessionId: options.sessionId,
      env: options.env,
    });
    emitter.emitDialEscalationEvaluation({
      tier: options.evaluation.tier,
      outcome: options.evaluation.outcome,
      reason: options.evaluation.reason,
    });
    emitter.emitKnownToolTurnDenominator();
  } catch {
    // fail-open
  }
}
