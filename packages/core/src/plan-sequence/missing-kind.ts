/**
 * Reader report for a present plan-sequence file whose sequence_kind is not
 * a string (#4843). Does not return a PlanSequence. parsePlanSequence still
 * refuses that file. set / createPlanSequence are not this path.
 */
import { existsSync, readFileSync } from "node:fs";
import { planSequencePath } from "./store.js";
import {
  detectTerminalEntryDrift,
  type TERMINAL_LIFECYCLE_CODE,
  type TerminalDriftSubject,
  type TerminalEntryDriftResult,
} from "./terminal-drift.js";
import { collectTerminalLifecycleOrigins } from "./terminal-drift-scan.js";
import type { PlanSequenceEntry, PlanTargetKind } from "./types.js";

const PLAN_TARGET_KINDS: readonly PlanTargetKind[] = [
  "pr",
  "issue",
  "story",
  "task",
  "phase",
  "checklist",
  "review",
];

export interface MissingSequenceKindDrift {
  readonly code: typeof TERMINAL_LIFECYCLE_CODE;
  readonly message: string;
  readonly originPath: string;
  readonly folder: "completed" | "cancelled";
}

export interface MissingSequenceKindReport {
  readonly path: string;
  readonly missingField: "sequence_kind";
  readonly authorized: false;
  readonly terminalLifecycle: MissingSequenceKindDrift | null;
  readonly message: string;
}

export interface MissingSequenceKindPayload {
  readonly ok: false;
  readonly authorized: false;
  readonly path: string;
  readonly missing_field: "sequence_kind";
  readonly message: string;
  readonly terminal_lifecycle_drift?: MissingSequenceKindDrift;
}

function isPlanTargetKind(value: string): value is PlanTargetKind {
  return (PLAN_TARGET_KINDS as readonly string[]).includes(value);
}

/** Same entry shape parsePlanSequence accepts, without requiring sequence_kind. */
function readDriftSubject(obj: Record<string, unknown>): TerminalDriftSubject | null {
  if (!Array.isArray(obj.entries) || obj.entries.length === 0) {
    return null;
  }
  const entries: PlanSequenceEntry[] = [];
  for (const item of obj.entries) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return null;
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== "string" || typeof entry.kind !== "string") {
      return null;
    }
    if (!isPlanTargetKind(entry.kind)) {
      return null;
    }
    entries.push({
      id: entry.id,
      kind: entry.kind,
      title: typeof entry.title === "string" ? entry.title : undefined,
      issue: typeof entry.issue === "number" ? entry.issue : undefined,
      status:
        entry.status === "completed" || entry.status === "skipped" || entry.status === "pending"
          ? entry.status
          : "pending",
    });
  }
  const current_index = typeof obj.current_index === "number" ? obj.current_index : 0;
  const exhausted = obj.exhausted === true || current_index >= entries.length;
  return { entries, current_index, exhausted };
}

function formatMissingKindMessage(path: string, drift: TerminalEntryDriftResult): string {
  const head = `${path} is not an authorized sequence: missing sequence_kind (plan-sequence: sequence_kind required).`;
  if (!drift.drifted) {
    return head;
  }
  return `${head}\n${drift.message}`;
}

/**
 * Report when the file would throw `sequence_kind required` and nothing earlier.
 * Returns null when the file is absent, not that failure, or sequence_kind is a string.
 */
export function inspectMissingSequenceKind(projectRoot: string): MissingSequenceKindReport | null {
  const path = planSequencePath(projectRoot);
  if (!existsSync(path)) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.sequence_id !== "string" || obj.sequence_id.length === 0) {
    return null;
  }
  if (typeof obj.sequence_kind === "string") {
    return null;
  }
  const subject = readDriftSubject(obj);
  const drift =
    subject === null
      ? ({ drifted: false } as const)
      : detectTerminalEntryDrift(subject, collectTerminalLifecycleOrigins(projectRoot));
  const terminalLifecycle = drift.drifted
    ? {
        code: drift.code,
        message: drift.message,
        originPath: drift.originPath,
        folder: drift.folder,
      }
    : null;
  return {
    path,
    missingField: "sequence_kind",
    authorized: false,
    terminalLifecycle,
    message: formatMissingKindMessage(path, drift),
  };
}

export function missingSequenceKindPayload(
  report: MissingSequenceKindReport,
): MissingSequenceKindPayload {
  const payload: MissingSequenceKindPayload = {
    ok: false,
    authorized: false,
    path: report.path,
    missing_field: report.missingField,
    message: report.message,
  };
  if (report.terminalLifecycle === null) {
    return payload;
  }
  return { ...payload, terminal_lifecycle_drift: report.terminalLifecycle };
}
