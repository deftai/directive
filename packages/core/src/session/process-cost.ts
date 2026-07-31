/**
 * Local process-cost ceremony events (#2994).
 *
 * Always-on, best-effort appends to `.deft-cache/events.jsonl`.
 * Not gated on valueFeedback (distinct from #1709 attribution).
 * No remote / Product Insights upload (#2603 not required).
 *
 * Types are declared locally (not imported from session-start) so this module
 * does not form an import cycle with session-start call sites.
 */
import { type BehavioralEventRecord, emit } from "../lifecycle/events.js";
import { PROCESS_COST_EVENT_NAMES } from "./process-cost-constants.js";

export {
  PROCESS_COST_EVENT_NAMES,
  PROCESS_COST_REQUIRED_PAYLOAD,
  type ProcessCostEventName,
} from "./process-cost-constants.js";

/** Ceremony tier labels mirror session-start cold|rearm (#2992 / #2994). */
export type ProcessCostCeremonyTier = "cold" | "rearm";

export interface ProcessCostStepTiming {
  readonly name: string;
  readonly duration_ms: number;
  readonly skipped?: boolean;
}

export interface EmitProcessCostOptions {
  readonly projectRoot: string;
  /**
   * Optional explicit log path for tests.
   * When omitted, `emit` resolves via DEFT_EVENT_LOG then `.deft-cache/events.jsonl`
   * (must not pre-resolve the default here or DEFT_EVENT_LOG is bypassed).
   */
  readonly logPath?: string | null;
}

export interface SessionStartProcessCostInput {
  readonly ceremonyTier: ProcessCostCeremonyTier;
  readonly durationMs: number;
  readonly exitCode: number;
  readonly ready?: boolean;
  readonly optionalNetwork?: boolean;
  readonly steps?: readonly ProcessCostStepTiming[];
}

export interface SessionRitualBlockedProcessCostInput {
  readonly toolName: string;
  readonly code?: string;
  readonly recoveryTier?: "cold" | "rearm";
  readonly detail?: string;
}

/**
 * Emit `session:start` after cold/re-arm ceremony completes (or fails early).
 * Returns null on any failure (telemetry must not interrupt session:start).
 */
export function emitSessionStartProcessCost(
  input: SessionStartProcessCostInput,
  options: EmitProcessCostOptions,
): BehavioralEventRecord | null {
  try {
    const payload: Record<string, unknown> = {
      ceremony_tier: input.ceremonyTier,
      duration_ms: input.durationMs,
      exit_code: input.exitCode,
    };
    if (input.ready !== undefined) {
      payload.ready = input.ready;
    }
    if (input.optionalNetwork !== undefined) {
      payload.optional_network = input.optionalNetwork;
    }
    if (input.steps !== undefined) {
      payload.steps = input.steps.map((step) => {
        const entry: Record<string, unknown> = {
          name: step.name,
          duration_ms: step.duration_ms,
        };
        if (step.skipped === true) {
          entry.skipped = true;
        }
        return entry;
      });
    }
    // Pass logPath only when caller overrides; otherwise emit honors DEFT_EVENT_LOG.
    const emitOptions: {
      projectRoot: string;
      logPath?: string | null;
    } = { projectRoot: options.projectRoot };
    if (options.logPath !== undefined) {
      emitOptions.logPath = options.logPath;
    }
    return emit(PROCESS_COST_EVENT_NAMES.sessionStart, payload, emitOptions);
  } catch {
    return null;
  }
}

/**
 * Emit `session:ritual-blocked` on PreToolUse ritual-not-ready deny.
 * Returns null on any failure (telemetry must not change deny verdict).
 */
export function emitSessionRitualBlockedProcessCost(
  input: SessionRitualBlockedProcessCostInput,
  options: EmitProcessCostOptions,
): BehavioralEventRecord | null {
  try {
    const payload: Record<string, unknown> = {
      tool_name: input.toolName,
      code: input.code ?? "ritual-not-ready",
    };
    if (input.recoveryTier !== undefined) {
      payload.recovery_tier = input.recoveryTier;
    }
    if (input.detail !== undefined && input.detail.length > 0) {
      // Cap free-form detail so JSONL lines stay bounded.
      payload.detail =
        input.detail.length > 240 ? `${input.detail.slice(0, 237)}...` : input.detail;
    }
    const emitOptions: {
      projectRoot: string;
      logPath?: string | null;
    } = { projectRoot: options.projectRoot };
    if (options.logPath !== undefined) {
      emitOptions.logPath = options.logPath;
    }
    return emit(PROCESS_COST_EVENT_NAMES.sessionRitualBlocked, payload, emitOptions);
  } catch {
    return null;
  }
}
