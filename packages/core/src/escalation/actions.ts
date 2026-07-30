/**
 * Operator-facing escalation actions: file, list, resolve, batch-approve (#518).
 */

import { randomBytes } from "node:crypto";
import {
  listEscalations,
  listOpenEscalations,
  loadEscalation,
  parseEscalation,
  saveEscalation,
  utcIso,
  validateEscalationType,
} from "./store.js";
import {
  BATCH_APPROVABLE_TYPES,
  DEFAULT_SLA_HOURS,
  ESCALATION_SCHEMA_VERSION,
  type EscalationDecision,
  type EscalationEvent,
  type EscalationType,
  isBatchApprovableType,
  isEscalationDecision,
} from "./types.js";

function newEscalationId(now?: Date): string {
  const ts = (now ?? new Date())
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  const suffix = randomBytes(3).toString("hex");
  return `esc-${ts}-${suffix}`;
}

export interface FileEscalationInput {
  readonly projectRoot: string;
  readonly type: string;
  readonly title: string;
  readonly body?: string;
  readonly agentId?: string;
  readonly contextRefs?: readonly string[];
  readonly slaHours?: number;
  readonly dangerous?: boolean;
  readonly id?: string;
  readonly now?: Date;
}

export function fileEscalation(input: FileEscalationInput): EscalationEvent {
  const type = validateEscalationType(input.type);
  const title = input.title.trim();
  if (title.length === 0) {
    throw new Error("escalation title must be non-empty");
  }
  const createdAt = utcIso(input.now);
  const event: EscalationEvent = {
    schemaVersion: ESCALATION_SCHEMA_VERSION,
    id: input.id?.trim() || newEscalationId(input.now),
    agentId: (input.agentId ?? "agent").trim() || "agent",
    type,
    title,
    body: input.body ?? "",
    contextRefs: input.contextRefs ?? [],
    createdAt,
    slaHours:
      input.slaHours !== undefined && input.slaHours > 0 ? input.slaHours : DEFAULT_SLA_HOURS[type],
    status: "open",
    dangerous: input.dangerous === true,
    resolution: null,
  };
  // Round-trip through parse to guarantee store shape.
  const parsed = parseEscalation(event);
  if (parsed === null) {
    throw new Error("internal: filed escalation failed validation");
  }
  saveEscalation(input.projectRoot, parsed);
  return parsed;
}

export interface ResolveEscalationInput {
  readonly projectRoot: string;
  readonly id: string;
  readonly decision: string;
  readonly actor?: string;
  readonly note?: string | null;
  readonly answer?: string | null;
  readonly now?: Date;
}

export type ResolveEscalationResult =
  | { readonly ok: true; readonly event: EscalationEvent }
  | {
      readonly ok: false;
      readonly code: "not-found" | "already-resolved" | "invalid-decision";
      readonly message: string;
    };

export function resolveEscalation(input: ResolveEscalationInput): ResolveEscalationResult {
  const decisionRaw = input.decision.trim().toLowerCase();
  if (!isEscalationDecision(decisionRaw)) {
    return {
      ok: false,
      code: "invalid-decision",
      message: `invalid decision '${input.decision}'; expected one of: approved, denied, answered, dismissed`,
    };
  }
  const existing = loadEscalation(input.projectRoot, input.id);
  if (existing === null) {
    return {
      ok: false,
      code: "not-found",
      message: `escalation not found: ${input.id}`,
    };
  }
  if (existing.status !== "open") {
    return {
      ok: false,
      code: "already-resolved",
      message: `escalation already resolved: ${input.id}`,
    };
  }
  const resolved: EscalationEvent = {
    ...existing,
    status: "resolved",
    resolution: {
      decision: decisionRaw as EscalationDecision,
      resolvedAt: utcIso(input.now),
      resolvedBy: (input.actor ?? "operator").trim() || "operator",
      note: input.note ?? null,
      answer: input.answer ?? null,
    },
  };
  saveEscalation(input.projectRoot, resolved);
  return { ok: true, event: resolved };
}

export interface BatchApproveInput {
  readonly projectRoot: string;
  /** Limit to these ids; empty/undefined = all open batch-eligible. */
  readonly ids?: readonly string[];
  readonly actor?: string;
  readonly note?: string | null;
  /** When false (default), skip `dangerous: true` items. */
  readonly includeDangerous?: boolean;
  readonly now?: Date;
}

export interface BatchApproveResult {
  readonly approved: EscalationEvent[];
  readonly skipped: Array<{ id: string; reason: string }>;
}

/**
 * Bulk-approve only `cmd_approval` and `question` open items.
 * design_decision / approval / resource / external must use individual resolve.
 * Dangerous items are skipped unless `includeDangerous` is true.
 */
export function batchApproveEscalations(input: BatchApproveInput): BatchApproveResult {
  const open = listOpenEscalations(input.projectRoot);
  const idFilter =
    input.ids !== undefined && input.ids.length > 0
      ? new Set(input.ids.map((x) => x.trim()).filter((x) => x.length > 0))
      : null;

  const approved: EscalationEvent[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const event of open) {
    if (idFilter !== null && !idFilter.has(event.id)) {
      continue;
    }
    if (!isBatchApprovableType(event.type)) {
      skipped.push({
        id: event.id,
        reason: `type ${event.type} is not batch-approvable (use escalation:resolve); allowed bulk types: ${BATCH_APPROVABLE_TYPES.join(", ")}`,
      });
      continue;
    }
    if (event.dangerous && input.includeDangerous !== true) {
      skipped.push({
        id: event.id,
        reason: "dangerous=true — resolve individually or pass --include-dangerous",
      });
      continue;
    }
    const decision: EscalationDecision = event.type === "question" ? "answered" : "approved";
    const result = resolveEscalation({
      projectRoot: input.projectRoot,
      id: event.id,
      decision,
      actor: input.actor,
      note: input.note ?? "batch-approve",
      answer: event.type === "question" ? (input.note ?? "acknowledged") : null,
      now: input.now,
    });
    if (result.ok) {
      approved.push(result.event);
    } else {
      skipped.push({ id: event.id, reason: result.message });
    }
  }

  return { approved, skipped };
}

export function listEscalationsFiltered(
  projectRoot: string,
  opts: { openOnly?: boolean; type?: EscalationType } = {},
): EscalationEvent[] {
  const base =
    opts.openOnly === true ? listOpenEscalations(projectRoot) : listEscalations(projectRoot);
  if (opts.type === undefined) return base;
  return base.filter((e) => e.type === opts.type);
}
