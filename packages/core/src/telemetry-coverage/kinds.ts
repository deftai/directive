/**
 * Event-kind ↔ emitter-method mapping for verify:telemetry-coverage (#3362).
 */

import { RUN_SUMMARY_EVENT_KINDS, type RunSummaryEventKind } from "../run-summary/types.js";

export { RUN_SUMMARY_EVENT_KINDS, type RunSummaryEventKind };

/** Typed RunSummaryEmitter methods that write each schema kind. */
export const EVENT_KIND_TO_EMITTER_METHODS: Readonly<
  Record<RunSummaryEventKind, readonly string[]>
> = {
  session_start: ["emitSessionStart"],
  dial_transition: ["emitDialTransition"],
  dial_escalation_evaluation: ["emitDialEscalationEvaluation"],
  check_invocation: ["emitCheckInvocation"],
  tool_turn_denominator: ["emitToolTurnDenominator", "emitKnownToolTurnDenominator"],
  verification: ["emitVerification"],
  acceptance: ["emitAcceptance"],
  acceptance_stamp: ["emitAcceptanceStamp"],
};

/**
 * Kinds asserted by the shared fake-trial harness.
 * Author this list independently of RUN_SUMMARY_EVENT_KINDS — spreading the
 * schema would make a missing fixture undetectable (#3362 Greptile).
 * Enroll here and add a DEFAULT_TRIAL_STEPS entry; do not rebuild a per-kind harness.
 */
export const ENROLLED_FIELD_FIXTURE_KINDS: readonly RunSummaryEventKind[] = [
  "session_start",
  "dial_transition",
  "dial_escalation_evaluation",
  "check_invocation",
  "tool_turn_denominator",
  "verification",
  "acceptance",
  "acceptance_stamp",
];

const GENERIC_EMIT_METHODS = new Set(["emit"]);

/** True when a discovered class method is a distinct event surface (not the generic emit). */
export function isKindEmitterMethod(name: string): boolean {
  return name.startsWith("emit") && !GENERIC_EMIT_METHODS.has(name);
}

export function methodsForKind(kind: string): readonly string[] {
  if (kind in EVENT_KIND_TO_EMITTER_METHODS) {
    return EVENT_KIND_TO_EMITTER_METHODS[kind as RunSummaryEventKind];
  }
  return [];
}

export function kindForMethod(method: string): RunSummaryEventKind | undefined {
  for (const kind of RUN_SUMMARY_EVENT_KINDS) {
    if (EVENT_KIND_TO_EMITTER_METHODS[kind].includes(method)) {
      return kind;
    }
  }
  return undefined;
}
