/**
 * Typed escalation events + local queue store (#518 slim / #2948 Wave 5).
 *
 * Full priority-inbox web UI and metrics remain residual — this module is the
 * versioned schema + `.deft/escalations/` file queue for CLI batching.
 */

/** Fixed vocabulary of escalation reasons (#518). */
export const ESCALATION_TYPES = [
  "cmd_approval",
  "design_decision",
  "approval",
  "resource",
  "external",
  "question",
] as const;

export type EscalationType = (typeof ESCALATION_TYPES)[number];

/**
 * Types eligible for `escalation:batch-approve`.
 * design_decision / approval / resource / external stay individual resolve.
 */
export const BATCH_APPROVABLE_TYPES = ["cmd_approval", "question"] as const;

export type BatchApprovableType = (typeof BATCH_APPROVABLE_TYPES)[number];

export const ESCALATION_STATUSES = ["open", "resolved"] as const;

export type EscalationStatus = (typeof ESCALATION_STATUSES)[number];

export const ESCALATION_DECISIONS = ["approved", "denied", "answered", "dismissed"] as const;

export type EscalationDecision = (typeof ESCALATION_DECISIONS)[number];

/** Default SLA hours per type (issue #518 table). */
export const DEFAULT_SLA_HOURS: Readonly<Record<EscalationType, number>> = {
  cmd_approval: 1,
  design_decision: 4,
  approval: 4,
  resource: 4,
  external: 72,
  question: 24,
};

export interface EscalationResolution {
  readonly decision: EscalationDecision;
  readonly resolvedAt: string;
  readonly resolvedBy: string;
  readonly note: string | null;
  /** Free-text answer for `question` type (optional for other types). */
  readonly answer: string | null;
}

/**
 * Versioned escalation event (YAML shape from #518, camelCase on disk).
 *
 * ```json
 * {
 *   "schemaVersion": 1,
 *   "id": "esc-…",
 *   "agentId": "agent-b",
 *   "type": "design_decision",
 *   "title": "…",
 *   "body": "…",
 *   "contextRefs": ["xbrief/…", "#496"],
 *   "createdAt": "2026-07-30T10:00:00Z",
 *   "slaHours": 4,
 *   "status": "open",
 *   "dangerous": false,
 *   "resolution": null
 * }
 * ```
 */
export interface EscalationEvent {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly agentId: string;
  readonly type: EscalationType;
  readonly title: string;
  readonly body: string;
  readonly contextRefs: readonly string[];
  readonly createdAt: string;
  readonly slaHours: number;
  readonly status: EscalationStatus;
  /**
   * When true, batch-approve skips this item unless `--include-dangerous`.
   * Use for shell write-scope cmd_approval, PR merges, and similar.
   */
  readonly dangerous: boolean;
  readonly resolution: EscalationResolution | null;
}

export const ESCALATION_SCHEMA_VERSION = 1 as const;
export const ESCALATION_DIR = ".deft/escalations";

export function isEscalationType(value: string): value is EscalationType {
  return (ESCALATION_TYPES as readonly string[]).includes(value);
}

export function isBatchApprovableType(type: EscalationType): type is BatchApprovableType {
  return (BATCH_APPROVABLE_TYPES as readonly string[]).includes(type);
}

export function isEscalationDecision(value: string): value is EscalationDecision {
  return (ESCALATION_DECISIONS as readonly string[]).includes(value);
}
