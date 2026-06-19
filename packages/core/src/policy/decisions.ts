import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const PENDING_DECISIONS_AUDIT_DIR_REL = "vbrief/.audit";
export const PENDING_DECISIONS_LOG_NAME = "pending-human-decisions.jsonl";
export const DECISION_STATUS_PENDING = "pending";
export const DECISION_STATUS_RESOLVED = "resolved";
export const DEFAULT_PENDING_DECISIONS_THRESHOLD = 5;

export interface DecisionBacklog {
  readonly pending_count: number;
  readonly by_kind: Readonly<Record<string, number>>;
  readonly resolved_in_window: number;
  readonly override_count: number;
  readonly p0_reversal_in_window: boolean;
  readonly override_rate: number;
}

export function pendingDecisionsLogPath(projectRoot: string): string {
  return join(resolve(projectRoot), PENDING_DECISIONS_AUDIT_DIR_REL, PENDING_DECISIONS_LOG_NAME);
}

function parseIsoTs(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const text = value.replace("Z", "+00:00");
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

/** Return every well-formed decision event in insertion order. */
export function readDecisionEvents(
  projectRoot: string,
  logPath?: string,
): Record<string, unknown>[] {
  const path = logPath ?? pendingDecisionsLogPath(projectRoot);
  if (!existsSync(path)) {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const raw of readFileSync(path, { encoding: "utf8" }).split("\n")) {
    const stripped = raw.trim();
    if (stripped.length === 0) {
      continue;
    }
    try {
      const obj = JSON.parse(stripped) as unknown;
      if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
        const rec = obj as Record<string, unknown>;
        if (typeof rec.decision_id === "string") {
          out.push(rec);
        }
      }
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

export interface SummarizeDecisionBacklogOptions {
  readonly now?: Date;
  readonly window_days?: number;
  readonly events?: readonly Record<string, unknown>[];
}

/** Summarise the pending-decisions log into a DecisionBacklog. */
export function summarizeDecisionBacklog(
  projectRoot: string,
  options: SummarizeDecisionBacklogOptions = {},
): DecisionBacklog {
  const records = options.events ?? readDecisionEvents(projectRoot);
  const latest = new Map<string, Record<string, unknown>>();
  for (const event of records) {
    const decisionId = event.decision_id;
    if (typeof decisionId === "string" && decisionId.length > 0) {
      latest.set(decisionId, event);
    }
  }

  const byKind: Record<string, number> = {};
  let pendingCount = 0;
  for (const event of latest.values()) {
    if (event.status === DECISION_STATUS_PENDING) {
      pendingCount += 1;
      const kind =
        typeof event.kind === "string" && event.kind.length > 0 ? event.kind : "unspecified";
      byKind[kind] = (byKind[kind] ?? 0) + 1;
    }
  }

  const nowDt = options.now ?? new Date();
  let resolvedInWindow = 0;
  let overrideCount = 0;
  let p0Reversal = false;
  const windowDays = options.window_days;

  for (const event of latest.values()) {
    if (event.status !== DECISION_STATUS_RESOLVED) {
      continue;
    }
    if (windowDays !== undefined) {
      const stamp = parseIsoTs(event.timestamp);
      if (stamp === null) {
        continue;
      }
      const ageDays = (nowDt.getTime() - stamp.getTime()) / (86400 * 1000);
      if (ageDays < 0 || ageDays > windowDays) {
        continue;
      }
    }
    resolvedInWindow += 1;
    if (event.override === true) {
      overrideCount += 1;
    }
    if (event.p0_reversal === true) {
      p0Reversal = true;
    }
  }

  const overrideRate = resolvedInWindow > 0 ? overrideCount / resolvedInWindow : 0;

  return {
    pending_count: pendingCount,
    by_kind: byKind,
    resolved_in_window: resolvedInWindow,
    override_count: overrideCount,
    p0_reversal_in_window: p0Reversal,
    override_rate: overrideRate,
  };
}

/** Return the Tier-1 backlog nudge string, or empty when at/under threshold. */
export function pendingDecisionsNudgeLine(
  count: number,
  threshold = DEFAULT_PENDING_DECISIONS_THRESHOLD,
): string {
  if (count <= threshold) {
    return "";
  }
  return (
    `[TIER-1] pending human-clearance backlog: ${count} decision(s) ` +
    `awaiting adjudication (> threshold ${threshold}). Tune wipCap to real ` +
    "review throughput or clear the backlog before dispatching more work."
  );
}
