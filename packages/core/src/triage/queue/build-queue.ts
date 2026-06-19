import { GROUP_ORDER } from "./constants.js";
import { deriveGroup } from "./derive-group.js";
import { compareSelectionKeys, matchedLabelFor, withinGroupSortKey } from "./selection.js";
import type { AuditEntry, CachedIssue, QueueBuildOptions, QueueItem } from "./types.js";

function resolveRank(
  issue: CachedIssue,
  number: number,
  rankByNumber: ReadonlyMap<number, number>,
): number | null {
  let candidate = rankByNumber.get(number);
  if (candidate === undefined) {
    candidate = issue.metadataRank ?? undefined;
  }
  if (typeof candidate !== "number" || !Number.isInteger(candidate)) {
    return null;
  }
  return candidate;
}

function resolveContinuation(
  issue: CachedIssue,
  number: number,
  continuationNumbers: ReadonlySet<number>,
): boolean {
  if (continuationNumbers.has(number)) {
    return true;
  }
  return Boolean(issue.continuation);
}

function resolveContinuationOrder(
  issue: CachedIssue,
  number: number,
  orderByNumber: ReadonlyMap<number, string>,
): string {
  let candidate = orderByNumber.get(number);
  if (candidate === undefined) {
    candidate = issue.continuationOrder;
  }
  return typeof candidate === "string" ? candidate : "";
}

function resolveDeficit(
  issue: CachedIssue,
  number: number,
  deficitByNumber: ReadonlyMap<number, number>,
): number | null {
  let candidate = deficitByNumber.get(number);
  if (candidate === undefined) {
    candidate = issue.bucketDeficit ?? undefined;
  }
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    return null;
  }
  return candidate;
}

function resolveBlocked(
  issue: CachedIssue,
  number: number,
  blockedNumbers: ReadonlySet<number>,
): boolean {
  if (blockedNumbers.has(number)) {
    return true;
  }
  return Boolean(issue.blocked);
}

/** Reduce audit entries to {issue_number: latest_entry} by timestamp. */
export function latestDecisionsByIssue(
  entries: readonly AuditEntry[],
): ReadonlyMap<number, AuditEntry> {
  const out = new Map<number, AuditEntry>();
  for (const entry of entries) {
    const n = entry.issue_number;
    if (typeof n !== "number") {
      continue;
    }
    const current = out.get(n);
    const stamp = entry.timestamp ?? "";
    const currentStamp = current?.timestamp ?? "";
    if (current === undefined || stamp > currentStamp) {
      out.set(n, entry);
    }
  }
  return out;
}

/** Compose the ranked queue. Mirrors scripts/triage_queue.py::build_queue. */
export function buildQueue(
  issues: readonly CachedIssue[],
  auditEntries: readonly AuditEntry[],
  options: {
    readonly repo: string;
    readonly queue?: QueueBuildOptions;
  },
): readonly QueueItem[] {
  const opts = options.queue ?? {};
  const rankingLabels = opts.rankingLabels ?? [];
  const activeReferenced = opts.activeReferenced ?? new Set<number>();
  const orphanIssueNumbers = opts.orphanIssueNumbers ?? new Set<number>();
  const rankByNumber = opts.rankByNumber ?? new Map<number, number>();
  const continuationNumbers = opts.continuationNumbers ?? new Set<number>();
  const continuationOrderByNumber = opts.continuationOrderByNumber ?? new Map<number, string>();
  const deficitByNumber = opts.deficitByNumber ?? new Map<number, number>();
  const blockedIssueNumbers = opts.blockedIssueNumbers ?? new Set<number>();
  const dropNetNew = Boolean(opts.finishBeforeStart && opts.wipAtCap);
  const includeBlocked = Boolean(opts.includeBlocked);
  const limit = opts.limit;

  const decisions = latestDecisionsByIssue(auditEntries);
  const grouped = new Map<string, CachedIssue[]>();
  for (const group of GROUP_ORDER) {
    grouped.set(group, []);
  }

  for (const issue of issues) {
    const n = issue.number;
    if (typeof n !== "number") {
      continue;
    }
    const isContinuation = resolveContinuation(issue, n, continuationNumbers);
    const isOrphan = orphanIssueNumbers.has(n);
    if (dropNetNew && !isContinuation && !isOrphan) {
      continue;
    }
    const isBlocked = resolveBlocked(issue, n, blockedIssueNumbers);
    const latest = decisions.get(n);
    const latestDecision = typeof latest?.decision === "string" ? latest.decision : null;

    let group: (typeof GROUP_ORDER)[number];
    if (isBlocked && !includeBlocked) {
      group = "BLOCKED";
    } else if (isOrphan) {
      group = "ORPHAN";
    } else {
      group = deriveGroup(latestDecision, activeReferenced.has(n));
    }

    const mutable: CachedIssue = { ...issue };
    mutable._latestDecision = latestDecision;
    mutable._blocked = isBlocked;
    mutable._resolvedRank = resolveRank(issue, n, rankByNumber);
    mutable._continuation = isContinuation;
    mutable._continuationOrder = resolveContinuationOrder(issue, n, continuationOrderByNumber);
    mutable._bucketDeficit = resolveDeficit(issue, n, deficitByNumber);
    grouped.get(group)?.push(mutable);
  }

  const out: QueueItem[] = [];
  for (const group of GROUP_ORDER) {
    const bucket = [...(grouped.get(group) ?? [])].sort((left, right) =>
      compareSelectionKeys(
        withinGroupSortKey(left, rankingLabels),
        withinGroupSortKey(right, rankingLabels),
      ),
    );
    for (const issue of bucket) {
      out.push({
        number: issue.number,
        title: String(issue.title ?? ""),
        state: String(issue.state ?? "open"),
        labels: issue.labels ?? [],
        updatedAt: String(issue.updatedAt ?? ""),
        group,
        latestDecision: issue._latestDecision ?? null,
        matchedLabel: matchedLabelFor(issue, rankingLabels),
        repo: options.repo,
      });
      if (limit !== null && limit !== undefined && out.length >= limit) {
        return out;
      }
    }
  }
  return out;
}
