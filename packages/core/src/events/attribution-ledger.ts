import { resolve } from "node:path";
import { type BehavioralEventRecord, DEFAULT_EVENT_LOG, emit } from "../lifecycle/events.js";
import {
  isValueFeedbackPathAllowed,
  resolveValueFeedback,
  type ValueFeedbackResolved,
} from "../policy/value-feedback.js";
import { ATTRIBUTION_EVENT_NAMES, type AttributionEventName } from "./attribution-constants.js";
import { buildAttributionEnrichment } from "./attribution-enrichment.js";

export {
  ALL_ATTRIBUTION_EVENT_NAMES,
  ATTRIBUTION_EVENT_NAMES,
  ATTRIBUTION_REQUIRED_PAYLOAD,
  type AttributionEventName,
} from "./attribution-constants.js";

/** Four value-attribution signal classes (#1709 RFC). */
export type SignalClass = "value" | "bypass" | "adoption" | "friction";

export interface EmitAttributionOptions {
  readonly projectRoot: string;
  readonly logPath?: string | null;
  /** Test hook: skip disk policy read. */
  readonly policyOverride?: ValueFeedbackResolved;
}

function resolveLedgerLogPath(projectRoot: string, logPath?: string | null): string {
  if (logPath !== undefined && logPath !== null) {
    return resolve(logPath);
  }
  return resolve(projectRoot, DEFAULT_EVENT_LOG);
}

function signalClassForEvent(name: AttributionEventName): SignalClass {
  const prefix = name.split(":")[0];
  if (prefix === "value" || prefix === "bypass" || prefix === "adoption" || prefix === "friction") {
    return prefix;
  }
  throw new Error(`attribution event '${name}' has unknown signal-class prefix`);
}

/**
 * Append an attribution ledger entry when valueFeedback emitEvents is allowed.
 * Returns null when gated OFF (no disk write).
 */
export function emitAttributionSignal(
  name: AttributionEventName,
  payload: Record<string, unknown>,
  options: EmitAttributionOptions,
): BehavioralEventRecord | null {
  try {
    const policy = options.policyOverride ?? resolveValueFeedback(options.projectRoot);
    if (!isValueFeedbackPathAllowed("emitEvents", policy)) {
      return null;
    }
    const signalClass = signalClassForEvent(name);
    const logPath = resolveLedgerLogPath(options.projectRoot, options.logPath);
    const enrichment = buildAttributionEnrichment(options.projectRoot);
    // Authoritative fields (signal_class + provenance enrichment) are spread LAST
    // so a caller payload can never silently shadow them (#2377 review).
    return emit(
      name,
      {
        ...payload,
        signal_class: signalClass,
        ...enrichment,
      },
      { logPath },
    );
  } catch {
    // Telemetry is best-effort; any failure must not interrupt gate callers (#1709).
    return null;
  }
}

/** Record a detection-bound gate catch (value class). */
export function recordGateCatch(
  projectRoot: string,
  source: string,
  detail: string,
  options: { logPath?: string | null; policyOverride?: ValueFeedbackResolved } = {},
): BehavioralEventRecord | null {
  return emitAttributionSignal(
    ATTRIBUTION_EVENT_NAMES.valueGateCatch,
    { source, detail },
    { projectRoot, ...options },
  );
}

/** Record a WIP-cap protect refusal (value class). */
export function recordWipCapProtect(
  projectRoot: string,
  count: number,
  cap: number,
  options: { logPath?: string | null; policyOverride?: ValueFeedbackResolved } = {},
): BehavioralEventRecord | null {
  return emitAttributionSignal(
    ATTRIBUTION_EVENT_NAMES.valueWipCapProtect,
    { source: "verify:wip-cap", count, cap },
    { projectRoot, ...options },
  );
}

/** Record a bypass/off-flow signal. */
export function recordBypassSignal(
  projectRoot: string,
  source: string,
  detail: string,
  options: { logPath?: string | null; policyOverride?: ValueFeedbackResolved } = {},
): BehavioralEventRecord | null {
  return emitAttributionSignal(
    ATTRIBUTION_EVENT_NAMES.bypassOffFlow,
    { source, detail },
    { projectRoot, ...options },
  );
}

/** Record an adoption/unused-capability signal. */
export function recordAdoptionSignal(
  projectRoot: string,
  capability: string,
  detail: string,
  options: { logPath?: string | null; policyOverride?: ValueFeedbackResolved } = {},
): BehavioralEventRecord | null {
  return emitAttributionSignal(
    ATTRIBUTION_EVENT_NAMES.adoptionUnusedCapability,
    { source: "adoption-registry", capability, detail },
    { projectRoot, ...options },
  );
}

/** Record a friction/directive-gap signal. */
export function recordFrictionSignal(
  projectRoot: string,
  source: string,
  detail: string,
  options: { logPath?: string | null; policyOverride?: ValueFeedbackResolved } = {},
): BehavioralEventRecord | null {
  return emitAttributionSignal(
    ATTRIBUTION_EVENT_NAMES.frictionDirectiveGap,
    { source, detail },
    { projectRoot, ...options },
  );
}
