/**
 * Derived ordered-plan cursor (#6205).
 *
 * The stored `current_index` is a hint, not the record. Wherever the plan is
 * read, an entry is finished when it is marked completed or skipped, or when
 * its lifecycle origin -- matched by the issue and story-id keys of
 * `resolvePlanEntryLifecycleOrigin`, never by title alone -- is a brief in
 * `completed/` of the same checkout. The effective current entry is the first
 * pending entry from the stored cursor on that is not finished. A cancelled
 * or failed origin stops the reader with `terminal-lifecycle` (#4129). An
 * entry with no lifecycle origin follows the stored cursor.
 *
 * Pure: callers pass the folder-scan facts.
 */
import {
  formatTerminalLifecycleDriftMessage,
  isStopOrigin,
  originMatchesKey,
  type PlanEntryOriginKey,
  resolvePlanEntryLifecycleOrigin,
  TERMINAL_LIFECYCLE_CODE,
  type TerminalDriftSubject,
  type TerminalLifecycleOrigin,
} from "./terminal-drift.js";
import type { PlanInsertApproval, PlanSequence, PlanSequenceEntry } from "./types.js";

/** One entry the reader passed because its origin brief is in completed/. */
export interface DerivedFinishedEntry {
  readonly index: number;
  readonly entry: PlanSequenceEntry;
  readonly originPath: string;
}

/** A cancelled or failed origin on the entry the reader reached. */
export interface DerivedCursorStop {
  readonly code: typeof TERMINAL_LIFECYCLE_CODE;
  readonly index: number;
  readonly entry: PlanSequenceEntry;
  readonly originPath: string;
  readonly folder: "completed" | "cancelled";
  readonly failed: boolean;
  readonly message: string;
}

export interface DerivedPlanCursor {
  /** Effective current index; `entries.length` when effectively exhausted. */
  readonly index: number;
  readonly entry: PlanSequenceEntry | null;
  readonly exhausted: boolean;
  /** Entries between the stored cursor and the effective one finished by a completed brief. */
  readonly derivedFinished: readonly DerivedFinishedEntry[];
  readonly stop: DerivedCursorStop | null;
}

/** Keys that may finish an entry: issue and story-id only, never title (#6205). */
export function finishingOriginKeys(entry: PlanSequenceEntry): PlanEntryOriginKey[] {
  const resolved = resolvePlanEntryLifecycleOrigin(entry);
  if (resolved.status === "skip") {
    return [];
  }
  return resolved.keys.filter((key) => key.kind === "issue" || key.kind === "story-id");
}

/** The completed (not failed) brief that finishes this entry, or null. */
export function findFinishingOrigin(
  entry: PlanSequenceEntry,
  terminals: readonly TerminalLifecycleOrigin[],
): TerminalLifecycleOrigin | null {
  const keys = finishingOriginKeys(entry);
  if (keys.length === 0) {
    return null;
  }
  for (const term of terminals) {
    if (term.folder !== "completed" || term.failed) continue;
    if (keys.some((key) => originMatchesKey(term, key))) {
      return term;
    }
  }
  return null;
}

/** The cancelled or failed origin that stops the reader on this entry, or null. */
function findStoppingOrigin(
  entry: PlanSequenceEntry,
  terminals: readonly TerminalLifecycleOrigin[],
): TerminalLifecycleOrigin | null {
  const resolved = resolvePlanEntryLifecycleOrigin(entry);
  if (resolved.status === "skip") {
    return null;
  }
  for (const term of terminals) {
    if (!isStopOrigin(term)) continue;
    if (resolved.keys.some((key) => originMatchesKey(term, key))) {
      return term;
    }
  }
  return null;
}

function isPending(entry: PlanSequenceEntry): boolean {
  return entry.status === undefined || entry.status === "pending";
}

/** Derive the effective cursor from the stored one and the terminal folder facts. */
export function derivePlanCursor(
  sequence: TerminalDriftSubject,
  terminals: readonly TerminalLifecycleOrigin[],
): DerivedPlanCursor {
  const total = sequence.entries.length;
  const exhausted = (derivedFinished: DerivedFinishedEntry[]): DerivedPlanCursor => ({
    index: total,
    entry: null,
    exhausted: true,
    derivedFinished,
    stop: null,
  });
  if (sequence.exhausted || sequence.current_index >= total) {
    return exhausted([]);
  }
  const derivedFinished: DerivedFinishedEntry[] = [];
  for (let index = Math.max(0, sequence.current_index); index < total; index += 1) {
    const entry = sequence.entries[index];
    if (entry === undefined || !isPending(entry)) {
      continue;
    }
    const finishing = findFinishingOrigin(entry, terminals);
    if (finishing !== null) {
      derivedFinished.push({ index, entry, originPath: finishing.path });
      continue;
    }
    const stopping = findStoppingOrigin(entry, terminals);
    if (stopping !== null) {
      return {
        index,
        entry,
        exhausted: false,
        derivedFinished,
        stop: {
          code: TERMINAL_LIFECYCLE_CODE,
          index,
          entry,
          originPath: stopping.path,
          folder: stopping.folder,
          failed: stopping.failed,
          message: formatTerminalLifecycleDriftMessage(
            entry,
            stopping.path,
            stopping.folder,
            stopping.failed,
          ),
        },
      };
    }
    return { index, entry, exhausted: false, derivedFinished, stop: null };
  }
  return exhausted(derivedFinished);
}

/** One entry the plan gate admits now (#4433). */
export interface AuthorizedPlanEntry {
  readonly index: number;
  readonly entry: PlanSequenceEntry;
}

/**
 * The current authorized set (#4433). It is the derived current entry alone
 * when `batching_allowed` is false or that entry has no `batch` label. With
 * `batching_allowed: true` it also holds every later entry of the adjacent run
 * that shares the current entry's label, minus entries that are not pending
 * or whose origin is in `completed/` or `cancelled/`. Empty when the cursor
 * is exhausted or stopped. Later batches are never in the set.
 */
export function derivePlanBatch(
  sequence: PlanSequence,
  cursor: DerivedPlanCursor,
  terminals: readonly TerminalLifecycleOrigin[],
): AuthorizedPlanEntry[] {
  if (cursor.stop !== null || cursor.exhausted || cursor.entry === null) {
    return [];
  }
  const authorized: AuthorizedPlanEntry[] = [{ index: cursor.index, entry: cursor.entry }];
  const label = cursor.entry.batch;
  if (sequence.batching_allowed !== true || label === undefined) {
    return authorized;
  }
  for (let index = cursor.index + 1; index < sequence.entries.length; index += 1) {
    const entry = sequence.entries[index];
    if (entry === undefined || entry.batch !== label) {
      break;
    }
    if (
      !isPending(entry) ||
      findFinishingOrigin(entry, terminals) !== null ||
      findStoppingOrigin(entry, terminals) !== null
    ) {
      continue;
    }
    authorized.push({ index, entry });
  }
  return authorized;
}

/**
 * Write the derived cursor into a sequence value: entries finished by a
 * completed brief become `completed`, and the stored cursor moves to the
 * effective one. An exhausted result keeps the last index, as advance does.
 * Pure; the store bumps generation on write.
 */
export function materializeDerivedCursor(
  sequence: PlanSequence,
  cursor: DerivedPlanCursor,
  now = new Date().toISOString(),
): PlanSequence {
  const finished = new Set(cursor.derivedFinished.map((d) => d.index));
  const entries = sequence.entries.map((entry, index) =>
    finished.has(index) ? { ...entry, status: "completed" as const } : entry,
  );
  const lastIndex = Math.max(0, entries.length - 1);
  return {
    ...sequence,
    entries,
    current_index: cursor.exhausted ? Math.min(sequence.current_index, lastIndex) : cursor.index,
    exhausted: cursor.exhausted,
    updated_at: now,
  };
}

/** True when the derived cursor differs from the stored one. */
export function cursorMovedPastStored(sequence: PlanSequence, cursor: DerivedPlanCursor): boolean {
  return (
    cursor.derivedFinished.length > 0 ||
    cursor.exhausted !== sequence.exhausted ||
    (!cursor.exhausted && cursor.index !== sequence.current_index)
  );
}

export type InsertPlanEntryResult =
  | { readonly ok: true; readonly sequence: PlanSequence; readonly position: number }
  | { readonly ok: false; readonly reason: string };

/**
 * Insert one pending entry at the effective cursor or at a named later index
 * and append its approval row when one was spent (#6205). An earlier index, an index past the
 * end, or a duplicate entry id is refused. Pure.
 */
export function insertApprovedPlanEntry(input: {
  readonly sequence: PlanSequence;
  readonly cursor: DerivedPlanCursor;
  readonly entry: PlanSequenceEntry;
  readonly position?: number;
  /** Null when no approval was needed (bound gate off); no row is written. */
  readonly approval: PlanInsertApproval | null;
  readonly now?: string;
}): InsertPlanEntryResult {
  const { sequence, cursor, entry } = input;
  if (cursor.stop !== null) {
    return { ok: false, reason: cursor.stop.message };
  }
  // The effective cursor; the end of the plan when it is exhausted.
  const effective = cursor.index;
  const position = input.position ?? effective;
  if (!Number.isInteger(position) || position < effective) {
    return {
      ok: false,
      reason:
        `plan-sequence:insert: position ${String(position)} is before the effective cursor ` +
        `(${String(effective)}); insert at the cursor or a later index.`,
    };
  }
  if (position > sequence.entries.length) {
    return {
      ok: false,
      reason:
        `plan-sequence:insert: position ${String(position)} is past the end of the plan ` +
        `(${String(sequence.entries.length)} entries).`,
    };
  }
  const id = entry.id.trim().toLowerCase();
  if (sequence.entries.some((e) => e.id.trim().toLowerCase() === id)) {
    return {
      ok: false,
      reason: `plan-sequence:insert: entry id ${entry.id} is already in the plan.`,
    };
  }
  const now = input.now ?? new Date().toISOString();
  const base = materializeDerivedCursor(sequence, cursor, now);
  const entries = [...base.entries];
  entries.splice(position, 0, { ...entry, status: "pending" });
  return {
    ok: true,
    position,
    sequence: {
      ...base,
      entries,
      current_index: effective,
      exhausted: false,
      ...(input.approval !== null
        ? { insert_approvals: [...(sequence.insert_approvals ?? []), input.approval] }
        : {}),
      updated_at: now,
    },
  };
}

/** The approval row for one entry id, or null (#6205). */
export function findInsertApproval(
  sequence: PlanSequence,
  entryId: string,
): PlanInsertApproval | null {
  return sequence.insert_approvals?.find((row) => row.entry_id === entryId) ?? null;
}
