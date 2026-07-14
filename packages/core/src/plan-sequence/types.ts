/**
 * Ordered-plan continuation boundary (#2402).
 *
 * Continuation words ("next", "resume", "proceed") advance only within the
 * narrowest operator-approved sequence. Exhaustion fails closed. Separate from
 * triage queue continuationNumbers / continuationOrder.
 */

export const PLAN_SEQUENCE_FILENAME = "plan-sequence.json";
export const PLAN_SEQUENCE_CONTRACT = "ordered-plan-continuation" as const;

export type PlanSequenceKind =
  | "delivery"
  | "review"
  | "implementation"
  | "swarm"
  | "triage"
  | "cohort"
  | "checklist";

export type PlanTargetKind = "pr" | "issue" | "story" | "task" | "phase" | "checklist" | "review";

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
}

export interface PlanSequenceVerifyInput {
  readonly targetKind: PlanTargetKind;
  readonly target: string;
}

export type PlanSequenceVerifyResult =
  | { readonly ok: true; readonly entry: PlanSequenceEntry; readonly index: number }
  | {
      readonly ok: false;
      readonly code: "missing" | "exhausted" | "mismatch" | "kind-mismatch";
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
  };
}

/** Mark current entry completed and advance index; may set exhausted. */
export function advancePlanSequence(
  sequence: PlanSequence,
  now = new Date().toISOString(),
): PlanSequence {
  if (sequence.exhausted || sequence.current_index >= sequence.entries.length) {
    return { ...sequence, exhausted: true, updated_at: now };
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
  };
}
