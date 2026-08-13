/**
 * Ritual+gate share from a #3282 run-summary stream (#3320).
 *
 * Share is ritual+gate invocations over the emitted tool/turn denominator.
 * Absence of the denominator is unevaluable — never invent a share from counts.
 */

import { RUN_SUMMARY_STDOUT_PREFIX, type RunSummaryLine } from "./types.js";

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

/** True when n is a finite integer usable as a share denominator. */
export function isValidToolTurnDenominator(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) && value > 0
  );
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

/**
 * Compute ritual+gate share from summary lines alone.
 * Uses the latest session in the stream. Missing/invalid denominator → unevaluable.
 */
export function computeRitualGateShare(lines: readonly RunSummaryLine[]): RitualGateShare {
  const sessionId = lastSessionId(lines);
  const sessionLines =
    sessionId === null ? [] : lines.filter((line) => line.session_id === sessionId);
  let ritualGateCount = 0;
  let totalToolTurns: number | null = null;
  for (const line of sessionLines) {
    if (line.event === "check_invocation") {
      ritualGateCount += 1;
    }
    const denom = readToolTurnDenominator(line);
    if (denom !== undefined) {
      totalToolTurns = denom;
    }
  }
  if (totalToolTurns === null) {
    return { evaluable: false, ritualGateCount, totalToolTurns: null, share: null };
  }
  return {
    evaluable: true,
    ritualGateCount,
    totalToolTurns,
    share: ritualGateCount / totalToolTurns,
  };
}
