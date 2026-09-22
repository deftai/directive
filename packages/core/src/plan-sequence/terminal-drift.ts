/**
 * Terminal ordered-plan current-entry drift (#4129).
 *
 * Pure predicate: a non-terminal current plan entry whose resolvable
 * Directive lifecycle origin already sits in completed/ or cancelled/
 * (failed stamps live in completed/). Callers pass folder-scan facts.
 * Filesystem-only — no GitHub issue-state client.
 */
import type { PlanSequenceEntry } from "./types.js";

export const TERMINAL_LIFECYCLE_CODE = "terminal-lifecycle" as const;

export type PlanEntryOriginKeyKind = "issue" | "pr" | "story-id" | "title";

export interface PlanEntryOriginKey {
  readonly kind: PlanEntryOriginKeyKind;
  readonly value: string;
}

export type PlanEntryOriginResolution =
  | { readonly status: "skip"; readonly reason: "no-origin" }
  | { readonly status: "resolved"; readonly keys: readonly PlanEntryOriginKey[] };

export interface TerminalLifecycleOrigin {
  readonly path: string;
  readonly folder: "completed" | "cancelled";
  readonly issueNumbers: readonly number[];
  readonly prNumbers: readonly number[];
  readonly storyIds: readonly string[];
  readonly title?: string;
  readonly failed: boolean;
  readonly hasTransitionWrite: boolean;
}

export type TerminalEntryDriftResult =
  | { readonly drifted: false }
  | {
      readonly drifted: true;
      readonly code: typeof TERMINAL_LIFECYCLE_CODE;
      readonly entry: PlanSequenceEntry;
      readonly index: number;
      readonly originPath: string;
      readonly folder: "completed" | "cancelled";
      readonly message: string;
    };

function normalizeToken(raw: string): string {
  return raw.trim().toLowerCase().replace(/^#/, "");
}

function parseWholePositiveInt(token: string): number | null {
  if (!/^\d+$/u.test(token)) {
    return null;
  }
  const n = Number(token);
  if (!Number.isInteger(n) || n <= 0) {
    return null;
  }
  return n;
}

function parsePositiveInt(raw: string): number | null {
  return parseWholePositiveInt(raw.trim().replace(/^#/u, ""));
}

function parsePrNumber(raw: string): number | null {
  const trimmed = raw.trim().replace(/^#/u, "");
  if (/^pr-/iu.test(trimmed)) {
    return parseWholePositiveInt(trimmed.replace(/^pr-/iu, ""));
  }
  return parseWholePositiveInt(trimmed);
}

function pushKey(keys: PlanEntryOriginKey[], key: PlanEntryOriginKey): void {
  if (keys.some((existing) => existing.kind === key.kind && existing.value === key.value)) {
    return;
  }
  keys.push(key);
}

function resolvedOrSkip(keys: PlanEntryOriginKey[]): PlanEntryOriginResolution {
  if (keys.length === 0) {
    return { status: "skip", reason: "no-origin" };
  }
  return { status: "resolved", keys };
}

/**
 * Map a plan entry to lifecycle origin keys per `PlanSequenceEntry.kind`.
 * No-origin kinds skip (do not fail closed). Issue/PR/story resolve from
 * `issue`, numeric `id`, and story id/title.
 */
export function resolvePlanEntryLifecycleOrigin(
  entry: PlanSequenceEntry,
): PlanEntryOriginResolution {
  const keys: PlanEntryOriginKey[] = [];
  if (entry.issue !== undefined && Number.isFinite(entry.issue) && entry.issue > 0) {
    pushKey(keys, { kind: "issue", value: String(entry.issue) });
  }
  switch (entry.kind) {
    case "issue": {
      const n = parsePositiveInt(entry.id);
      if (n !== null) {
        pushKey(keys, { kind: "issue", value: String(n) });
      }
      return resolvedOrSkip(keys);
    }
    case "pr": {
      const n = parsePrNumber(entry.id);
      if (n !== null) {
        pushKey(keys, { kind: "pr", value: String(n) });
      }
      return resolvedOrSkip(keys);
    }
    case "story": {
      const n = parsePositiveInt(entry.id);
      if (n !== null) {
        pushKey(keys, { kind: "issue", value: String(n) });
      }
      pushKey(keys, { kind: "story-id", value: normalizeToken(entry.id) });
      if (entry.title !== undefined && entry.title.trim().length > 0) {
        pushKey(keys, { kind: "title", value: normalizeToken(entry.title) });
      }
      return resolvedOrSkip(keys);
    }
    case "task":
    case "phase":
    case "checklist":
    case "review":
      return resolvedOrSkip(keys);
  }
}

function originMatchesKey(term: TerminalLifecycleOrigin, key: PlanEntryOriginKey): boolean {
  switch (key.kind) {
    case "issue":
      return term.issueNumbers.includes(Number(key.value));
    case "pr":
      return term.prNumbers.includes(Number(key.value));
    case "story-id":
      return term.storyIds.some((id) => normalizeToken(id) === key.value);
    case "title":
      return term.title !== undefined && normalizeToken(term.title) === key.value;
  }
}

function findMatchingTerminal(
  keys: readonly PlanEntryOriginKey[],
  terminals: readonly TerminalLifecycleOrigin[],
): TerminalLifecycleOrigin | null {
  for (const term of terminals) {
    if (keys.some((key) => originMatchesKey(term, key))) {
      return term;
    }
  }
  return null;
}

export function formatTerminalLifecycleDriftMessage(
  entry: PlanSequenceEntry,
  originPath: string,
  folder: "completed" | "cancelled",
): string {
  const issue = entry.issue !== undefined ? ` (#${entry.issue})` : "";
  return [
    `Current ordered-plan entry ${entry.kind}:${entry.id}${issue} is already terminal in ${originPath} (${folder}/).`,
    "The sequence still lists it as the authorized next target.",
    "Do not treat this as permission to pick the next id.",
    "Do not run task plan-sequence:advance until the operator reviews this contradiction.",
    "Stop and ask the operator whether to advance, replace, or clear the sequence.",
  ].join("\n");
}

function currentEntryIsNonTerminal(entry: PlanSequenceEntry): boolean {
  return entry.status === undefined || entry.status === "pending";
}

/**
 * Entries, index, and exhausted only. Not a parsed PlanSequence: a missing
 * sequence_kind must not be filled in to run this check (#4843).
 */
export interface TerminalDriftSubject {
  readonly entries: readonly PlanSequenceEntry[];
  readonly current_index: number;
  readonly exhausted: boolean;
}

/**
 * Drift when the current entry is still pending and a resolvable origin
 * already sits in completed/ or cancelled/ (or carries a failed stamp
 * recorded on that terminal fact). One current entry, not every entry.
 * GitHub `closed` is not an input.
 */
export function detectTerminalEntryDrift(
  sequence: TerminalDriftSubject | null,
  terminals: readonly TerminalLifecycleOrigin[],
): TerminalEntryDriftResult {
  if (sequence === null) {
    return { drifted: false };
  }
  if (sequence.exhausted || sequence.current_index >= sequence.entries.length) {
    return { drifted: false };
  }
  const index = sequence.current_index;
  const entry = sequence.entries[index];
  if (entry === undefined || !currentEntryIsNonTerminal(entry)) {
    return { drifted: false };
  }
  const resolved = resolvePlanEntryLifecycleOrigin(entry);
  if (resolved.status === "skip") {
    return { drifted: false };
  }
  const hit = findMatchingTerminal(resolved.keys, terminals);
  if (hit === null) {
    return { drifted: false };
  }
  return {
    drifted: true,
    code: TERMINAL_LIFECYCLE_CODE,
    entry,
    index,
    originPath: hit.path,
    folder: hit.folder,
    message: formatTerminalLifecycleDriftMessage(entry, hit.path, hit.folder),
  };
}
