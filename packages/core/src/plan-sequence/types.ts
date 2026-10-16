/**
 * Ordered-plan continuation boundary (#2402).
 *
 * Continuation words ("next", "resume", "proceed") advance only within the
 * narrowest operator-approved sequence. Exhaustion fails closed. Separate from
 * triage queue continuationNumbers / continuationOrder.
 */

import {
  detectTerminalEntryDrift,
  TERMINAL_LIFECYCLE_CODE,
  type TerminalLifecycleOrigin,
} from "./terminal-drift.js";

export const PLAN_SEQUENCE_FILENAME = "plan-sequence.json";
export const PLAN_SEQUENCE_CONTRACT = "ordered-plan-continuation" as const;

/** Exact tracked planning path for coverage closed-shape inertness (#5551). */
export const PLAN_SEQUENCE_REL_PATH = `.deft/${PLAN_SEQUENCE_FILENAME}`;

export const PLAN_SEQUENCE_KINDS = [
  "delivery",
  "review",
  "implementation",
  "swarm",
  "triage",
  "cohort",
  "checklist",
] as const;

export type PlanSequenceKind = (typeof PLAN_SEQUENCE_KINDS)[number];

export const PLAN_TARGET_KINDS = [
  "pr",
  "issue",
  "story",
  "task",
  "phase",
  "checklist",
  "review",
] as const;

export type PlanTargetKind = (typeof PLAN_TARGET_KINDS)[number];

const PLAN_SEQUENCE_ENTRY_STATUSES = new Set(["pending", "completed", "skipped"]);

/** Closed top-level keys admitted by coverage closed-shape proof (#5551). */
const PLAN_SEQUENCE_CLOSED_TOP_KEYS = new Set([
  "sequence_id",
  "sequence_kind",
  "entries",
  "current_index",
  "batching_allowed",
  "continuation_past_final",
  "exhausted",
  "authorized_by",
  "created_at",
  "updated_at",
  "contract",
  "generation",
  "source_revision",
]);

const PLAN_SEQUENCE_ENTRY_CLOSED_KEYS = new Set(["id", "kind", "title", "issue", "status"]);

export interface PlanSequenceEntry {
  readonly id: string;
  readonly kind: PlanTargetKind;
  readonly title?: string;
  readonly issue?: number;
  readonly status?: "pending" | "completed" | "skipped";
}

export interface PlanSequence {
  readonly sequence_id: string;
  readonly sequence_kind: PlanSequenceKind;
  readonly entries: readonly PlanSequenceEntry[];
  readonly current_index: number;
  readonly batching_allowed: boolean;
  /** Default false — exhausted sequences require fresh operator approval. */
  readonly continuation_past_final: boolean;
  readonly exhausted: boolean;
  readonly authorized_by: string;
  readonly created_at: string;
  readonly updated_at: string;
  /** Optional stamp; when present must equal PLAN_SEQUENCE_CONTRACT (#5551). */
  readonly contract?: typeof PLAN_SEQUENCE_CONTRACT;
  /** Monotonic mutation generation. Missing on disk compares as 0 (#3907). */
  readonly generation: number;
  /** Source Git revision recorded at publish. Not the compare key (#3910). */
  readonly source_revision: string;
}

export function isPlanSequenceKind(value: unknown): value is PlanSequenceKind {
  return typeof value === "string" && (PLAN_SEQUENCE_KINDS as readonly string[]).includes(value);
}

export function isPlanTargetKind(value: unknown): value is PlanTargetKind {
  return typeof value === "string" && (PLAN_TARGET_KINDS as readonly string[]).includes(value);
}

/**
 * Closed-shape proof for coverage inertness (#5551 Prefer-A Bound).
 * Stronger than parsePlanSequence: refuses unknown keys, non-enum kinds,
 * non-integer / out-of-range current_index, and mismatched contract stamps.
 */
export function isClosedPlanSequenceShape(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!PLAN_SEQUENCE_CLOSED_TOP_KEYS.has(key)) return false;
  }
  if (typeof obj.sequence_id !== "string" || obj.sequence_id.length === 0) return false;
  if (!isPlanSequenceKind(obj.sequence_kind)) return false;
  if (!Array.isArray(obj.entries) || obj.entries.length === 0) return false;
  if (typeof obj.current_index !== "number" || !Number.isInteger(obj.current_index)) return false;
  if (obj.current_index < 0 || obj.current_index > obj.entries.length) return false;
  if (typeof obj.batching_allowed !== "boolean") return false;
  if (typeof obj.continuation_past_final !== "boolean") return false;
  if (typeof obj.exhausted !== "boolean") return false;
  if (typeof obj.authorized_by !== "string") return false;
  if (typeof obj.created_at !== "string" || obj.created_at.length === 0) return false;
  if (typeof obj.updated_at !== "string" || obj.updated_at.length === 0) return false;
  if (Object.hasOwn(obj, "contract") && obj.contract !== PLAN_SEQUENCE_CONTRACT) return false;
  if (Object.hasOwn(obj, "generation")) {
    if (
      typeof obj.generation !== "number" ||
      !Number.isInteger(obj.generation) ||
      obj.generation < 0
    ) {
      return false;
    }
  }
  if (Object.hasOwn(obj, "source_revision") && typeof obj.source_revision !== "string") {
    return false;
  }

  for (let i = 0; i < obj.entries.length; i++) {
    const item = obj.entries[i];
    if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
    const entry = item as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (!PLAN_SEQUENCE_ENTRY_CLOSED_KEYS.has(key)) return false;
    }
    if (typeof entry.id !== "string" || entry.id.length === 0) return false;
    if (!isPlanTargetKind(entry.kind)) return false;
    if (Object.hasOwn(entry, "title") && typeof entry.title !== "string") return false;
    if (Object.hasOwn(entry, "issue") && typeof entry.issue !== "number") return false;
    if (
      Object.hasOwn(entry, "status") &&
      (typeof entry.status !== "string" || !PLAN_SEQUENCE_ENTRY_STATUSES.has(entry.status))
    ) {
      return false;
    }
  }
  return true;
}

export interface PlanSequenceVerifyInput {
  readonly targetKind: PlanTargetKind;
  readonly target: string;
  /** Folder-scan facts for #4129 terminal-lifecycle drift. Omit or [] for match-only. */
  readonly terminalOrigins?: readonly TerminalLifecycleOrigin[];
}

export type PlanSequenceVerifyResult =
  | { readonly ok: true; readonly entry: PlanSequenceEntry; readonly index: number }
  | {
      readonly ok: false;
      readonly code: "missing" | "exhausted" | "mismatch" | "kind-mismatch" | "terminal-lifecycle";
      readonly message: string;
    };

export type ContinuationResolution =
  | { readonly action: "advance"; readonly entry: PlanSequenceEntry; readonly index: number }
  | {
      readonly action: "queue";
      readonly reason: "no-active-sequence" | "explicit-queue-override" | "not-plan-first-phrase";
    }
  | {
      readonly action: "ask";
      readonly reason: "exhausted" | "ambiguous-sequences";
      readonly message: string;
    };

/** Phrases that are explicit queue/backlog selection even mid-plan. */
export const EXPLICIT_QUEUE_PHRASES = [
  "what's the queue",
  "whats the queue",
  "what is the queue",
  "build a cohort",
  "triage queue",
  "show the queue",
  "queue-driven",
  "from the backlog",
] as const;

/** Bare continuation / selection phrases that bind to ordered-plan when active. */
export const PLAN_FIRST_PHRASES = [
  "what's next",
  "whats next",
  "what next",
  "what should i work on next",
  "next task",
  "next pr",
  "next issue",
  "next story",
  "move on",
  "proceed",
  "resume",
  "next",
] as const;

export const EXHAUSTED_FAIL_CLOSED_MESSAGE =
  "I have completed the approved sequence. Starting another item would exceed the current authorization. Please name the next target or approve queue-driven selection.";

function normalizeTarget(raw: string): string {
  return raw.trim().toLowerCase().replace(/^#/, "");
}

function entryMatches(
  entry: PlanSequenceEntry,
  targetKind: PlanTargetKind,
  target: string,
): boolean {
  if (entry.kind !== targetKind) {
    return false;
  }
  const needle = normalizeTarget(target);
  if (normalizeTarget(entry.id) === needle) {
    return true;
  }
  if (entry.issue !== undefined && String(entry.issue) === needle) {
    return true;
  }
  if (entry.title !== undefined && normalizeTarget(entry.title) === needle) {
    return true;
  }
  return false;
}

export function isExplicitQueueAsk(text: string): boolean {
  const lower = text.toLowerCase();
  return EXPLICIT_QUEUE_PHRASES.some((p) => lower.includes(p));
}

export function isPlanFirstPhrase(text: string): boolean {
  const lower = text.toLowerCase();
  return PLAN_FIRST_PHRASES.some((p) => lower.includes(p));
}

/** Resolve how continuation/selection language should be handled. */
export function resolveContinuation(
  text: string,
  sequence: PlanSequence | null,
): ContinuationResolution {
  // Explicit backlog/cohort asks always select from the queue, even mid-plan.
  if (isExplicitQueueAsk(text)) {
    return { action: "queue", reason: "explicit-queue-override" };
  }
  // No active sequence → queue (same as today's #1149 path).
  if (sequence === null) {
    return { action: "queue", reason: "no-active-sequence" };
  }
  // Active sequence + plan-first / continuation phrase → bind to current entry.
  if (!isPlanFirstPhrase(text)) {
    return { action: "queue", reason: "not-plan-first-phrase" };
  }
  if (sequence.exhausted || sequence.current_index >= sequence.entries.length) {
    if (sequence.continuation_past_final) {
      return { action: "queue", reason: "no-active-sequence" };
    }
    return {
      action: "ask",
      reason: "exhausted",
      message: EXHAUSTED_FAIL_CLOSED_MESSAGE,
    };
  }
  const index = sequence.current_index;
  const entry = sequence.entries[index];
  if (entry === undefined) {
    return {
      action: "ask",
      reason: "exhausted",
      message: EXHAUSTED_FAIL_CLOSED_MESSAGE,
    };
  }
  return { action: "advance", entry, index };
}

export function verifyPlanTarget(
  sequence: PlanSequence | null,
  input: PlanSequenceVerifyInput,
): PlanSequenceVerifyResult {
  if (sequence === null) {
    return {
      ok: false,
      code: "missing",
      message:
        "No active ordered-plan sequence. Set one with plan-sequence:set, or obtain explicit operator approval for this target.",
    };
  }
  if (sequence.exhausted || sequence.current_index >= sequence.entries.length) {
    return {
      ok: false,
      code: "exhausted",
      message: EXHAUSTED_FAIL_CLOSED_MESSAGE,
    };
  }
  const index = sequence.current_index;
  const entry = sequence.entries[index];
  if (entry === undefined) {
    return {
      ok: false,
      code: "exhausted",
      message: EXHAUSTED_FAIL_CLOSED_MESSAGE,
    };
  }
  const drift = detectTerminalEntryDrift(sequence, input.terminalOrigins ?? []);
  if (drift.drifted) {
    return {
      ok: false,
      code: TERMINAL_LIFECYCLE_CODE,
      message: drift.message,
    };
  }
  if (entry.kind !== input.targetKind) {
    return {
      ok: false,
      code: "kind-mismatch",
      message: `Current ordered-plan entry is kind=${entry.kind} id=${entry.id}; requested kind=${input.targetKind} target=${input.target}.`,
    };
  }
  if (!entryMatches(entry, input.targetKind, input.target)) {
    return {
      ok: false,
      code: "mismatch",
      message: `Target ${input.targetKind}:${input.target} is not the current ordered-plan entry (${entry.kind}:${entry.id}).`,
    };
  }
  return { ok: true, entry, index };
}

export function createPlanSequence(input: {
  sequence_id: string;
  sequence_kind: PlanSequenceKind;
  entries: readonly PlanSequenceEntry[];
  authorized_by: string;
  batching_allowed?: boolean;
  continuation_past_final?: boolean;
  now?: string;
  source_revision?: string;
}): PlanSequence {
  if (input.entries.length === 0) {
    throw new Error("plan-sequence: entries must be non-empty");
  }
  const now = input.now ?? new Date().toISOString();
  return {
    sequence_id: input.sequence_id,
    sequence_kind: input.sequence_kind,
    entries: input.entries.map((e) => ({ ...e, status: e.status ?? "pending" })),
    current_index: 0,
    batching_allowed: input.batching_allowed ?? false,
    continuation_past_final: input.continuation_past_final ?? false,
    exhausted: false,
    authorized_by: input.authorized_by,
    created_at: now,
    updated_at: now,
    generation: 0,
    source_revision: input.source_revision ?? "",
  };
}

/** Mark current entry completed and advance index; may set exhausted. */
export function advancePlanSequence(
  sequence: PlanSequence,
  now = new Date().toISOString(),
): PlanSequence {
  if (sequence.exhausted || sequence.current_index >= sequence.entries.length) {
    return {
      ...sequence,
      exhausted: true,
      updated_at: now,
      generation: sequence.generation + 1,
    };
  }
  const entries = sequence.entries.map((e, i) =>
    i === sequence.current_index ? { ...e, status: "completed" as const } : e,
  );
  const nextIndex = sequence.current_index + 1;
  const exhausted = nextIndex >= entries.length;
  return {
    ...sequence,
    entries,
    current_index: exhausted ? sequence.current_index : nextIndex,
    exhausted,
    updated_at: now,
    generation: sequence.generation + 1,
  };
}

export function parsePlanSequence(raw: unknown): PlanSequence {
  if (raw === null || typeof raw !== "object") {
    throw new Error("plan-sequence: expected object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.sequence_id !== "string" || obj.sequence_id.length === 0) {
    throw new Error("plan-sequence: sequence_id required");
  }
  if (typeof obj.sequence_kind !== "string") {
    throw new Error("plan-sequence: sequence_kind required");
  }
  if (!Array.isArray(obj.entries) || obj.entries.length === 0) {
    throw new Error("plan-sequence: entries must be a non-empty array");
  }
  const entries: PlanSequenceEntry[] = obj.entries.map((item, i) => {
    if (item === null || typeof item !== "object") {
      throw new Error(`plan-sequence: entries[${i}] must be an object`);
    }
    const e = item as Record<string, unknown>;
    if (typeof e.id !== "string" || typeof e.kind !== "string") {
      throw new Error(`plan-sequence: entries[${i}] requires id and kind`);
    }
    return {
      id: e.id,
      kind: e.kind as PlanTargetKind,
      title: typeof e.title === "string" ? e.title : undefined,
      issue: typeof e.issue === "number" ? e.issue : undefined,
      status:
        e.status === "completed" || e.status === "skipped" || e.status === "pending"
          ? e.status
          : "pending",
    };
  });
  const current_index = typeof obj.current_index === "number" ? obj.current_index : 0;
  const exhausted = obj.exhausted === true || current_index >= entries.length;
  let generation = 0;
  if (
    typeof obj.generation === "number" &&
    Number.isInteger(obj.generation) &&
    obj.generation >= 0
  ) {
    generation = obj.generation;
  }
  const source_revision = typeof obj.source_revision === "string" ? obj.source_revision : "";
  return {
    sequence_id: obj.sequence_id,
    sequence_kind: obj.sequence_kind as PlanSequenceKind,
    entries,
    current_index,
    batching_allowed: obj.batching_allowed === true,
    continuation_past_final: obj.continuation_past_final === true,
    exhausted,
    authorized_by: typeof obj.authorized_by === "string" ? obj.authorized_by : "",
    created_at: typeof obj.created_at === "string" ? obj.created_at : new Date().toISOString(),
    updated_at: typeof obj.updated_at === "string" ? obj.updated_at : new Date().toISOString(),
    generation,
    source_revision,
  };
}
