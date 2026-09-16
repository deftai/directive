/**
 * Ritual+gate share from a #3282 run-summary stream (#3320).
 *
 * Share is ritual+gate invocations over the emitted tool/turn denominator.
 * Absence of the denominator is unevaluable — never invent a share from counts.
 */

import {
  ENV_TOTAL_TOOL_TURNS,
  RUN_SUMMARY_STDOUT_PREFIX,
  type RunSummaryLine,
  type ToolTurnDenominatorSource,
} from "./types.js";

export interface RitualGateShare {
  readonly evaluable: boolean;
  readonly ritualGateCount: number;
  readonly totalToolTurns: number | null;
  readonly share: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** True when n is a finite positive number usable as a share denominator. */
export function isValidToolTurnDenominator(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Read total_tool_turns from a line (top-level field or payload). */
export function readToolTurnDenominator(line: unknown): number | undefined {
  const rec = asRecord(line);
  if (rec === null) {
    return undefined;
  }
  if (isValidToolTurnDenominator(rec.total_tool_turns)) {
    return rec.total_tool_turns;
  }
  const payload = asRecord(rec.payload);
  if (payload !== null && isValidToolTurnDenominator(payload.total_tool_turns)) {
    return payload.total_tool_turns;
  }
  return undefined;
}

function parseLine(raw: string): RunSummaryLine | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const body = trimmed.startsWith(RUN_SUMMARY_STDOUT_PREFIX)
    ? trimmed.slice(RUN_SUMMARY_STDOUT_PREFIX.length)
    : trimmed;
  try {
    const parsed = JSON.parse(body) as unknown;
    const rec = asRecord(parsed);
    if (rec === null) {
      return null;
    }
    if (typeof rec.event !== "string" || typeof rec.session_id !== "string") {
      return null;
    }
    return parsed as RunSummaryLine;
  } catch {
    return null;
  }
}

/** Parse JSONL (or DEFT-TLM: prefixed stdout capture) into run-summary lines. */
export function parseRunSummaryJsonl(text: string): RunSummaryLine[] {
  const lines: RunSummaryLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = parseLine(raw);
    if (line !== null) {
      lines.push(line);
    }
  }
  return lines;
}

function lastSessionId(lines: readonly RunSummaryLine[]): string | null {
  let lastStart: string | null = null;
  let lastAny: string | null = null;
  for (const line of lines) {
    lastAny = line.session_id;
    if (line.event === "session_start") {
      lastStart = line.session_id;
    }
  }
  return lastStart ?? lastAny;
}

function readPositiveIntegerEnv(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || !Number.isFinite(n) || n <= 0) {
    return undefined;
  }
  return n;
}

function readDenominatorSource(line: unknown): ToolTurnDenominatorSource | undefined {
  const rec = asRecord(line);
  if (rec === null) {
    return undefined;
  }
  const payload = asRecord(rec.payload);
  const src = (payload !== null ? payload.denominator_source : undefined) ?? rec.denominator_source;
  if (src === "harness_actual" || src === "host_planned") {
    return src;
  }
  return undefined;
}

/**
 * Compute ritual+gate share from summary lines alone.
 * Uses the latest session in the stream. Missing/invalid denominator → unevaluable.
 * host_planned and TOTAL-equals-planned caps are unevaluable for the #3352 trigger (#4626).
 */
export function computeRitualGateShare(
  lines: readonly RunSummaryLine[],
  env?: NodeJS.ProcessEnv,
): RitualGateShare {
  const sessionId = lastSessionId(lines);
  const sessionLines =
    sessionId === null ? [] : lines.filter((line) => line.session_id === sessionId);
  let ritualGateCount = 0;
  let totalToolTurns: number | null = null;
  let lastSource: ToolTurnDenominatorSource | undefined;
  let plannedCap: number | undefined;
  for (const line of sessionLines) {
    if (line.event === "check_invocation") {
      ritualGateCount += 1;
    }
    const denom = readToolTurnDenominator(line);
    const source = readDenominatorSource(line);
    if (source === "host_planned" && denom !== undefined) {
      plannedCap = denom;
    }
    if (denom !== undefined) {
      totalToolTurns = denom;
      if (source !== undefined) {
        lastSource = source;
      }
    }
  }
  const plannedEnv =
    env !== undefined ? readPositiveIntegerEnv(env, "DEFT_MAX_TURNS") : undefined;
  const totalEnv =
    env !== undefined ? readPositiveIntegerEnv(env, ENV_TOTAL_TOOL_TURNS) : undefined;
  if (plannedEnv !== undefined) {
    plannedCap = plannedCap ?? plannedEnv;
  }
  const isCap =
    lastSource === "host_planned" ||
    (totalToolTurns !== null && plannedCap !== undefined && totalToolTurns === plannedCap) ||
    (totalEnv !== undefined &&
      plannedEnv !== undefined &&
      totalEnv === plannedEnv &&
      totalToolTurns !== null &&
      totalToolTurns === totalEnv);
  if (totalToolTurns === null) {
    return { evaluable: false, ritualGateCount, totalToolTurns: null, share: null };
  }
  const share = ritualGateCount / totalToolTurns;
  if (isCap) {
    return { evaluable: false, ritualGateCount, totalToolTurns, share };
  }
  return {
    evaluable: true,
    ritualGateCount,
    totalToolTurns,
    share,
  };
}
