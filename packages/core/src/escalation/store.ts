/**
 * Disk store for typed escalations under `.deft/escalations/` (#518).
 */

import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  ContainedWriteError,
  ContainedWriteErrorCode,
  containedWrite,
} from "../fs/contained-write.js";
import { assertWriteTargetSafe, ProjectionContainmentError } from "../fs/projection-containment.js";
import { escalationPath, escalationsDir } from "./paths.js";
import {
  DEFAULT_SLA_HOURS,
  ESCALATION_DECISIONS,
  ESCALATION_SCHEMA_VERSION,
  ESCALATION_STATUSES,
  ESCALATION_TYPES,
  type EscalationDecision,
  type EscalationEvent,
  type EscalationResolution,
  type EscalationStatus,
  type EscalationType,
  isEscalationType,
} from "./types.js";

export function utcIso(now?: Date): string {
  const dt = now ?? new Date();
  return dt.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Map projection containment refusals onto ContainedWriteError (stable codes). */
function refuseUnsafeTarget(root: string, targetAbs: string): void {
  try {
    assertWriteTargetSafe(root, targetAbs);
  } catch (err) {
    if (err instanceof ProjectionContainmentError) {
      const isSymlink = /symlink/i.test(err.message);
      throw new ContainedWriteError(
        err.message.replace(/^projection write refused:/i, "contained write refused:"),
        {
          code: isSymlink ? ContainedWriteErrorCode.SYMLINK : ContainedWriteErrorCode.ESCAPE,
          root,
          target: targetAbs,
          offendingPath: err.offendingPath,
        },
      );
    }
    throw err;
  }
}

/**
 * Atomic JSON write via containedWrite create + rename (#2980 wave B).
 * Refuses symlink/escape on the final target before publish; temp payload is
 * contained under project root so partial crash does not truncate live state.
 */
function writeJsonContained(
  projectRoot: string,
  targetPath: string,
  payload: unknown,
  prefix: string,
): void {
  const root = resolve(projectRoot);
  const absTarget = resolve(targetPath);
  refuseUnsafeTarget(root, absTarget);
  const dir = dirname(absTarget);
  const tmp = join(dir, `${prefix}${process.pid}-${Date.now()}.json.tmp`);
  try {
    containedWrite({
      root,
      target: tmp,
      data: `${JSON.stringify(payload, null, 2)}\n`,
      mode: "create",
    });
    refuseUnsafeTarget(root, absTarget);
    renameSync(tmp, absTarget);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

function readString(rec: Record<string, unknown>, key: string): string | null {
  const v = rec[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function readStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}

function readNumber(rec: Record<string, unknown>, key: string): number | null {
  const v = rec[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function parseResolution(raw: unknown): EscalationResolution | null {
  if (raw === null || raw === undefined) return null;
  const rec = record(raw);
  if (rec === null) return null;
  const decision = readString(rec, "decision");
  const resolvedAt = readString(rec, "resolvedAt") ?? readString(rec, "resolved_at") ?? utcIso();
  const resolvedBy = readString(rec, "resolvedBy") ?? readString(rec, "resolved_by") ?? "operator";
  if (decision === null || !(ESCALATION_DECISIONS as readonly string[]).includes(decision)) {
    return null;
  }
  return {
    decision: decision as EscalationDecision,
    resolvedAt,
    resolvedBy,
    note: readString(rec, "note"),
    answer: readString(rec, "answer"),
  };
}

/**
 * Parse an escalation JSON object.
 * Returns null when type/status/required fields are invalid (tests reject invalid types).
 */
export function parseEscalation(raw: unknown): EscalationEvent | null {
  const rec = record(raw);
  if (rec === null) return null;

  const id = readString(rec, "id");
  const agentId = readString(rec, "agentId") ?? readString(rec, "agent_id");
  const typeRaw = readString(rec, "type");
  const title = readString(rec, "title");
  if (id === null || agentId === null || typeRaw === null || title === null) return null;
  if (!isEscalationType(typeRaw)) return null;

  const statusRaw = (readString(rec, "status") ?? "open").toLowerCase();
  if (!(ESCALATION_STATUSES as readonly string[]).includes(statusRaw)) return null;

  const body = typeof rec.body === "string" ? rec.body : "";
  const contextRefs = readStringArray(rec.contextRefs ?? rec.context_refs);
  const createdAt = readString(rec, "createdAt") ?? readString(rec, "created_at") ?? utcIso();
  const sla =
    readNumber(rec, "slaHours") ??
    readNumber(rec, "sla_hours") ??
    DEFAULT_SLA_HOURS[typeRaw as EscalationType];
  const dangerous = rec.dangerous === true;
  const resolution = parseResolution(rec.resolution);

  return {
    schemaVersion: ESCALATION_SCHEMA_VERSION,
    id,
    agentId,
    type: typeRaw as EscalationType,
    title,
    body,
    contextRefs,
    createdAt,
    slaHours: sla > 0 ? sla : DEFAULT_SLA_HOURS[typeRaw as EscalationType],
    status: statusRaw as EscalationStatus,
    dangerous,
    resolution,
  };
}

/** Validate type string alone (unit tests + CLI). */
export function validateEscalationType(type: string): EscalationType {
  const normalized = type.trim().toLowerCase();
  if (!isEscalationType(normalized)) {
    throw new Error(
      `invalid escalation type '${type}'; expected one of: ${ESCALATION_TYPES.join(", ")}`,
    );
  }
  return normalized;
}

export function saveEscalation(projectRoot: string, event: EscalationEvent): void {
  writeJsonContained(projectRoot, escalationPath(projectRoot, event.id), event, ".esc.");
}

export function loadEscalation(projectRoot: string, escalationId: string): EscalationEvent | null {
  const path = escalationPath(projectRoot, escalationId);
  if (!existsSync(path)) return null;
  try {
    return parseEscalation(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return null;
  }
}

export function listEscalations(projectRoot: string): EscalationEvent[] {
  const dir = escalationsDir(projectRoot);
  if (!existsSync(dir)) return [];
  const out: EscalationEvent[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const event = parseEscalation(JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown);
      if (event !== null) out.push(event);
    } catch {
      // skip corrupt files
    }
  }
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return out;
}

export function listOpenEscalations(projectRoot: string): EscalationEvent[] {
  return listEscalations(projectRoot).filter((e) => e.status === "open");
}
