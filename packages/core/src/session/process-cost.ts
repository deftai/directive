/**
 * Local process-cost ceremony events (#2994).
 *
 * Always-on, best-effort appends to `.deft-cache/events.jsonl`.
 * Not gated on valueFeedback (distinct from #1709 attribution).
 * No remote / Product Insights upload (#2603 not required).
 */
import { resolve } from "node:path";
import {
  type BehavioralEventRecord,
  DEFAULT_EVENT_LOG,
  emit,
} from "../lifecycle/events.js";
import { PROCESS_COST_EVENT_NAMES } from "./process-cost-constants.js";
import type { SessionCeremonyTier, SessionStartStepTiming } from "./session-start.js";

export {
  PROCESS_COST_EVENT_NAMES,
  PROCESS_COST_REQUIRED_PAYLOAD,
  type ProcessCostEventName,
} from "./process-cost-constants.js";

export interface EmitProcessCostOptions {
  readonly projectRoot: string;
  readonly logPath?: string | null;
}

export interface SessionStartProcessCostInput {
  readonly ceremonyTier: SessionCeremonyTier;
  readonly durationMs: number;
  readonly exitCode: number;
  readonly ready?: boolean;
  readonly optionalNetwork?: boolean;
  readonly steps?: readonly SessionStartStepTiming[];
}

export interface SessionRitualBlockedProcessCostInput {
  readonly toolName: string;
  readonly code?: string;
  readonly recoveryTier?: "cold" | "rearm";
  readonly detail?: string;
}

function resolveProcessCostLogPath(projectRoot: string, logPath?: string | null): string {
  if (logPath !== undefined && logPath !== null) {
    return resolve(logPath);
  }
  return resolve(projectRoot, DEFAULT_EVENT_LOG);
}

/**
 * Emit `session:start` after cold/re-arm ceremony completes.
 * Returns null on any failure (telemetry must not interrupt session:start).
 */
export function emitSessionStartProcessCost(
  input: SessionStartProcessCostInput,
  options: EmitProcessCostOptions,
): BehavioralEventRecord | null {
  try {
    const logPath = resolveProcessCostLogPath(options.projectRoot, options.logPath);
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
    return emit(PROCESS_COST_EVENT_NAMES.sessionStart, payload, {
      logPath,
      projectRoot: options.projectRoot,
    });
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
    const logPath = resolveProcessCostLogPath(options.projectRoot, options.logPath);
    const payload: Record<string, unknown> = {
      tool_name: input.toolName,
      code: input.code ?? "ritual-not-ready",
    };
    if (input.recoveryTier !== undefined) {
      payload.recovery_tier = input.recoveryTier;
    }
    if (input.detail !== undefined && input.detail.length > 0) {
      // Cap free-form detail so JSONL lines stay bounded.
      payload.detail = input.detail.length > 240 ? `${input.detail.slice(0, 237)}...` : input.detail;
    }
    return emit(PROCESS_COST_EVENT_NAMES.sessionRitualBlocked, payload, {
      logPath,
      projectRoot: options.projectRoot,
    });
  } catch {
    return null;
  }
}
