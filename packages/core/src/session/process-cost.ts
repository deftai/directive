/**
 * Local process-cost ceremony events (#2994).
 *
 * Always-on, best-effort appends to `.deft-cache/events.jsonl`.
 * Not gated on valueFeedback (distinct from #1709 attribution).
 * No remote / Product Insights upload (#2603 not required).
 *
 * Types are declared locally (not imported from session-start) so this module
 * does not form an import cycle with session-start call sites.
 *
 * #3508: composed readers live on `task value:show` (`value/readback.ts`).
 * This module measures CLI process time, not agent-turn wall clock (#3500).
 * ⊗ Do not use a printed CLI duration as #3286 Later graduation input.
 */
import { resolve } from "node:path";
import {
  type BehavioralEventRecord,
  DEFAULT_EVENT_LOG,
  emit,
  readEvents,
} from "../lifecycle/events.js";
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

export interface CeremonyCostRollup {
  /** Discriminator: CLI process time, not agent-turn wall clock (#3500 / #3508). */
  readonly kind: "cli_process_time";
  readonly windowLabel: string;
  readonly lastColdDurationMs: number | null;
  readonly lastRearmDurationMs: number | null;
  readonly lastColdSteps: readonly ProcessCostStepTiming[];
  readonly lastRearmSteps: readonly ProcessCostStepTiming[];
  readonly blockedRitualCount: number;
  readonly recoveryTierDistribution: Readonly<Record<string, number>>;
}

function isRecordPayload(payload: unknown): payload is Record<string, unknown> {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload);
}

function parseDetectedAt(record: BehavioralEventRecord): Date | null {
  const raw = record.detected_at;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }
  let text = raw.trim();
  if (text.endsWith("Z")) {
    text = `${text.slice(0, -1)}+00:00`;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function payloadNumber(payload: Record<string, unknown>, key: string): number | null {
  const raw = payload[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function resolveProcessCostLogPath(projectRoot: string, logPath?: string | null): string {
  if (logPath !== undefined && logPath !== null) {
    return resolve(logPath);
  }
  return resolve(projectRoot, DEFAULT_EVENT_LOG);
}

function parseSteps(payload: Record<string, unknown> | null): ProcessCostStepTiming[] {
  const raw = payload?.steps;
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: ProcessCostStepTiming[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const rec = item as Record<string, unknown>;
    if (typeof rec.name !== "string" || typeof rec.duration_ms !== "number") {
      continue;
    }
    if (!Number.isFinite(rec.duration_ms)) {
      continue;
    }
    const step: ProcessCostStepTiming = {
      name: rec.name,
      duration_ms: rec.duration_ms,
    };
    if (rec.skipped === true) {
      out.push({ ...step, skipped: true });
    } else {
      out.push(step);
    }
  }
  return out;
}

function lastSessionStartForTier(
  events: readonly BehavioralEventRecord[],
  tier: ProcessCostCeremonyTier,
): BehavioralEventRecord | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const record = events[i];
    if (record === undefined || record.event !== PROCESS_COST_EVENT_NAMES.sessionStart) {
      continue;
    }
    const payload = isRecordPayload(record.payload) ? record.payload : null;
    if (payload?.ceremony_tier === tier) {
      return record;
    }
  }
  return null;
}

function durationFrom(record: BehavioralEventRecord | null): number | null {
  if (record === null || !isRecordPayload(record.payload)) {
    return null;
  }
  return payloadNumber(record.payload, "duration_ms");
}

function formatWindowLabel(windowMs: number): string {
  const days = Math.round(windowMs / 86_400_000);
  if (days >= 1 && days * 86_400_000 === windowMs) {
    return `${days}d`;
  }
  const hours = Math.round(windowMs / 3_600_000);
  if (hours >= 1 && hours * 3_600_000 === windowMs) {
    return `${hours}h`;
  }
  return `${windowMs}ms`;
}

/**
 * Roll up ceremony cost from `.deft-cache/events.jsonl` (#3508).
 * Measures CLI process time, not agent-turn wall clock (#3500).
 */
export function computeCeremonyCostRollup(options: {
  projectRoot: string;
  logPath?: string | null;
  windowMs?: number;
  now?: Date;
  windowLabel?: string;
}): CeremonyCostRollup {
  const windowMs = options.windowMs ?? 7 * 86_400_000;
  const now = options.now ?? new Date();
  const sinceMs = now.getTime() - windowMs;
  const logPath = resolveProcessCostLogPath(options.projectRoot, options.logPath);
  let records: BehavioralEventRecord[] = [];
  try {
    records = readEvents(logPath).filter((record) => {
      if (
        record.event !== PROCESS_COST_EVENT_NAMES.sessionStart &&
        record.event !== PROCESS_COST_EVENT_NAMES.sessionRitualBlocked
      ) {
        return false;
      }
      const at = parseDetectedAt(record);
      if (at === null) {
        return true;
      }
      return at.getTime() >= sinceMs;
    });
  } catch {
    records = [];
  }

  const lastCold = lastSessionStartForTier(records, "cold");
  const lastRearm = lastSessionStartForTier(records, "rearm");

  const recoveryTierDistribution: Record<string, number> = {};
  let blockedRitualCount = 0;
  for (const record of records) {
    if (record.event !== PROCESS_COST_EVENT_NAMES.sessionRitualBlocked) {
      continue;
    }
    blockedRitualCount += 1;
    const payload = isRecordPayload(record.payload) ? record.payload : null;
    const rawTier = payload?.recovery_tier;
    const tier =
      typeof rawTier === "string" && rawTier.trim().length > 0 ? rawTier.trim() : "unspecified";
    recoveryTierDistribution[tier] = (recoveryTierDistribution[tier] ?? 0) + 1;
  }

  return {
    kind: "cli_process_time",
    windowLabel: options.windowLabel ?? formatWindowLabel(windowMs),
    lastColdDurationMs: durationFrom(lastCold),
    lastRearmDurationMs: durationFrom(lastRearm),
    lastColdSteps: parseSteps(
      lastCold !== null && isRecordPayload(lastCold.payload) ? lastCold.payload : null,
    ),
    lastRearmSteps: parseSteps(
      lastRearm !== null && isRecordPayload(lastRearm.payload) ? lastRearm.payload : null,
    ),
    blockedRitualCount,
    recoveryTierDistribution,
  };
}

function formatMs(value: number | null): string {
  return value === null ? "none" : `${value}ms`;
}

function formatSteps(steps: readonly ProcessCostStepTiming[]): string {
  if (steps.length === 0) {
    return "none";
  }
  return steps
    .map((step) => {
      const skip = step.skipped === true ? " skipped" : "";
      return `${step.name}=${step.duration_ms}ms${skip}`;
    })
    .join(", ");
}

function formatRecovery(distribution: Readonly<Record<string, number>>): string {
  const parts = Object.entries(distribution)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tier, count]) => `${tier}=${count}`);
  return parts.length === 0 ? "none" : parts.join(", ");
}

/**
 * Human rollup for the composed `value:show` reader (#3508).
 * CLI process time, not agent-turn wall clock (#3500).
 */
export function formatCeremonyCostReport(rollup: CeremonyCostRollup): string {
  const lines = [
    `[ceremony] CLI process time (not agent-turn wall clock; #3508 / #2994) ` +
      `(${rollup.windowLabel}):`,
    `  last cold: ${formatMs(rollup.lastColdDurationMs)}`,
    `  last re-arm: ${formatMs(rollup.lastRearmDurationMs)}`,
    `  steps (last cold ${PROCESS_COST_EVENT_NAMES.sessionStart}): ` +
      formatSteps(rollup.lastColdSteps),
    `  steps (last re-arm ${PROCESS_COST_EVENT_NAMES.sessionStart}): ` +
      formatSteps(rollup.lastRearmSteps),
    `  blocked-ritual (${PROCESS_COST_EVENT_NAMES.sessionRitualBlocked}): ` +
      String(rollup.blockedRitualCount),
    `  recovery-tier: ${formatRecovery(rollup.recoveryTierDistribution)}`,
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Operator-visible mutation `session:start` line (#3508).
 * CLI process time only. ⊗ not #3286 Later graduation input.
 */
export function formatSessionStartCeremonyCostLine(
  ceremonyTier: ProcessCostCeremonyTier,
  durationMs: number,
): string {
  return `[deft session] ceremony ${ceremonyTier} ${durationMs}ms`;
}
