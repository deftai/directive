/**
 * mutation-ledger.ts — typed deposit mutation log at the write chokepoint (#3392).
 *
 * A bound ledger records wrote / stripped / deleted as a side effect of
 * containedWrite / containedRemove. Callers cannot discard mutations by
 * ignoring a writer return value.
 *
 * Refs #3392 / #3378.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute, relative, resolve } from "node:path";

export const MUTATION_KINDS = ["wrote", "stripped", "deleted"] as const;
export type MutationKind = (typeof MUTATION_KINDS)[number];

export interface MutationEntry {
  readonly kind: MutationKind;
  readonly path: string;
}

export interface MutationSummary {
  readonly wrote: readonly string[];
  readonly stripped: readonly string[];
  readonly deleted: readonly string[];
  readonly mutations: readonly MutationEntry[];
}

/** Atomic-replace temps (`name.deft-<pid>.tmp`) are not logical mutations. */
const ATOMIC_TMP = /\.deft-\d+\.tmp$/u;

export function isAtomicWriteTemp(path: string): boolean {
  return ATOMIC_TMP.test(path.replace(/\\/g, "/"));
}

/** Posix-relative path under `root`, or empty when the target is not nested. */
export function toLedgerPath(root: string, target: string): string {
  const rootAbs = resolve(root);
  const targetAbs = isAbsolute(target) ? resolve(target) : resolve(rootAbs, target);
  const rel = relative(rootAbs, targetAbs);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) return "";
  return rel.split("\\").join("/");
}

export function emptyMutationSummary(): MutationSummary {
  return { wrote: [], stripped: [], deleted: [], mutations: [] };
}

function summarizeEntries(entries: readonly MutationEntry[]): MutationSummary {
  const latest = new Map<string, MutationKind>();
  const order: string[] = [];
  for (const entry of entries) {
    if (!latest.has(entry.path)) order.push(entry.path);
    latest.set(entry.path, entry.kind);
  }
  const wrote: string[] = [];
  const stripped: string[] = [];
  const deleted: string[] = [];
  const mutations: MutationEntry[] = [];
  for (const path of order) {
    const kind = latest.get(path);
    if (kind === undefined) continue;
    mutations.push({ kind, path });
    if (kind === "wrote") wrote.push(path);
    else if (kind === "stripped") stripped.push(path);
    else deleted.push(path);
  }
  return { wrote, stripped, deleted, mutations };
}

export interface MutationLedgerOptions {
  /**
   * Record intended writes/deletes and skip filesystem mutation (#3437).
   * Used by dry-run planning so the planned set is the execute write path.
   */
  readonly collectOnly?: boolean;
}

/** In-memory ledger for one deposit/refresh run. */
export class MutationLedger {
  readonly root: string;
  readonly collectOnly: boolean;
  private readonly recorded: MutationEntry[] = [];

  constructor(root: string, options?: MutationLedgerOptions) {
    this.root = resolve(root);
    this.collectOnly = options?.collectOnly === true;
  }

  record(kind: MutationKind, target: string): void {
    const path = toLedgerPath(this.root, target);
    if (path.length === 0) return;
    this.recorded.push({ kind, path });
  }

  entries(): readonly MutationEntry[] {
    return this.recorded;
  }

  summarize(): MutationSummary {
    return summarizeEntries(this.recorded);
  }
}

const storage = new AsyncLocalStorage<MutationLedger>();

export function activeMutationLedger(): MutationLedger | undefined {
  return storage.getStore();
}

/** Bind a ledger for the duration of `fn` (including awaited continuations). */
export function runWithMutationLedger<T>(
  root: string,
  fn: () => T,
  options?: MutationLedgerOptions,
): T {
  return storage.run(new MutationLedger(root, options), fn);
}

export function isCollectOnlyActive(): boolean {
  return activeMutationLedger()?.collectOnly === true;
}

export function recordActiveMutation(kind: MutationKind, target: string): void {
  activeMutationLedger()?.record(kind, target);
}

export function snapshotMutationSummary(): MutationSummary {
  return activeMutationLedger()?.summarize() ?? emptyMutationSummary();
}

/** Sorted union of wrote / stripped / deleted — the planned or staged path set. */
export function plannedPathsFromSummary(summary: MutationSummary): string[] {
  return [...new Set([...summary.wrote, ...summary.stripped, ...summary.deleted])].sort();
}

/** Human summary: `Removed:` plus wrote/stripped. Empty when nothing mutated. */
export function formatMutationSummary(summary: MutationSummary): string {
  const lines: string[] = [];
  if (summary.deleted.length > 0) {
    lines.push(`Removed: ${summary.deleted.join(", ")}`);
  }
  if (summary.wrote.length > 0) {
    lines.push(`wrote: ${summary.wrote.join(", ")}`);
  }
  if (summary.stripped.length > 0) {
    lines.push(`stripped: ${summary.stripped.join(", ")}`);
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

export function mutationSummaryJson(summary: MutationSummary): {
  wrote: string[];
  stripped: string[];
  deleted: string[];
} {
  return {
    wrote: [...summary.wrote],
    stripped: [...summary.stripped],
    deleted: [...summary.deleted],
  };
}
