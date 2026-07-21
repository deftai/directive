import { existsSync, readFileSync } from "node:fs";
import { evaluateHealth } from "../eval/health.js";
import {
  healthMetricsHistoryPath,
  helpedMetricsHistoryPath,
} from "../metrics/resolve-metrics-home.js";
import { resolveValueFeedback } from "../policy/value-feedback.js";
import { computeValueShowTrend, type SignalClass } from "../value/readback.js";
import {
  type EvalHealthSummary,
  type HelpedHealthSummary,
  LOCAL_SIGNAL_SUMMARY_SCHEMA_VERSION,
  type LocalSignalSummary,
  type ValueFeedbackSummary,
} from "./payload.js";

export const DEFAULT_LOCAL_SIGNAL_WINDOW = "30d";

function parseWindowMs(window: string): number {
  const match = window.trim().match(/^(\d+)\s*(d|h|m)$/i);
  if (match === null) {
    return 30 * 86_400_000;
  }
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  if (unit === "d") {
    return amount * 86_400_000;
  }
  if (unit === "h") {
    return amount * 3_600_000;
  }
  return amount * 60_000;
}

function readLastJsonlRecord(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    const last = lines[lines.length - 1];
    if (last === undefined) {
      return null;
    }
    const parsed: unknown = JSON.parse(last);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return null;
}

function buildValueFeedbackSummary(
  projectRoot: string,
  windowMs: number,
): ValueFeedbackSummary | null {
  const policy = resolveValueFeedback(projectRoot);
  if (!policy.enabled) {
    return {
      enabled: false,
      total: 0,
      byClass: { value: 0, bypass: 0, adoption: 0, friction: 0 },
      topEvents: [],
    };
  }
  const trend = computeValueShowTrend(projectRoot, { windowMs });
  const topEvents = Object.entries(trend.byEvent)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));
  const byClass = {} as Record<SignalClass, number>;
  for (const key of ["value", "bypass", "adoption", "friction"] as const) {
    byClass[key] = trend.byClass[key];
  }
  return {
    enabled: true,
    total: trend.total,
    byClass,
    topEvents,
  };
}

function buildEvalHealthSummary(projectRoot: string): EvalHealthSummary | null {
  const ledgerPath = healthMetricsHistoryPath(projectRoot);
  if (ledgerPath !== null) {
    const last = readLastJsonlRecord(ledgerPath);
    if (last !== null && typeof last.score === "number") {
      const contradictions = last.contradictions;
      return {
        score: last.score,
        contradictionCount: Array.isArray(contradictions) ? contradictions.length : 0,
        collectedAt: typeof last.recordedAt === "string" ? last.recordedAt : null,
      };
    }
  }
  const result = evaluateHealth({ projectRoot, persist: false });
  if (result.report === null) {
    return null;
  }
  return {
    score: result.report.score,
    contradictionCount: result.report.contradictions.length,
    collectedAt: result.report.recordedAt,
  };
}

function buildHelpedHealthSummary(projectRoot: string, window: string): HelpedHealthSummary | null {
  const windowMs = parseWindowMs(window);
  const since = Date.now() - windowMs;
  const helpedPath = helpedMetricsHistoryPath(projectRoot);
  let helpedCount = 0;
  if (helpedPath !== null && existsSync(helpedPath)) {
    try {
      const lines = readFileSync(helpedPath, "utf8")
        .split("\n")
        .filter((l) => l.trim());
      for (const line of lines) {
        try {
          const rec: unknown = JSON.parse(line);
          if (rec !== null && typeof rec === "object" && !Array.isArray(rec)) {
            const at = (rec as Record<string, unknown>).recordedAt;
            if (typeof at === "string") {
              const ts = Date.parse(at);
              if (!Number.isNaN(ts) && ts >= since) {
                helpedCount += 1;
              }
            }
          }
        } catch {
          // skip bad line
        }
      }
    } catch {
      helpedCount = 0;
    }
  }
  const healthPath = healthMetricsHistoryPath(projectRoot);
  let healthEntryCount = 0;
  if (healthPath !== null && existsSync(healthPath)) {
    try {
      const lines = readFileSync(healthPath, "utf8")
        .split("\n")
        .filter((l) => l.trim());
      for (const line of lines) {
        try {
          const rec: unknown = JSON.parse(line);
          if (rec !== null && typeof rec === "object" && !Array.isArray(rec)) {
            const at = (rec as Record<string, unknown>).recordedAt;
            if (typeof at === "string") {
              const ts = Date.parse(at);
              if (!Number.isNaN(ts) && ts >= since) {
                healthEntryCount += 1;
              }
            }
          }
        } catch {
          // skip
        }
      }
    } catch {
      healthEntryCount = 0;
    }
  }
  return {
    helpedCount: helpedPath === null ? null : helpedCount,
    healthEntryCount: healthPath === null ? null : healthEntryCount,
    window,
  };
}

/** Assemble minimized local ledger summaries (#2693 D15). */
export function assembleLocalSignalSummary(
  projectRoot: string,
  options: { window?: string } = {},
): LocalSignalSummary {
  const window = options.window ?? DEFAULT_LOCAL_SIGNAL_WINDOW;
  const windowMs = parseWindowMs(window);
  return {
    schemaVersion: LOCAL_SIGNAL_SUMMARY_SCHEMA_VERSION,
    window,
    valueFeedback: buildValueFeedbackSummary(projectRoot, windowMs),
    evalHealth: buildEvalHealthSummary(projectRoot),
    helpedHealth: buildHelpedHealthSummary(projectRoot, window),
  };
}
