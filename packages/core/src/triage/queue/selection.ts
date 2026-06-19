import type { CachedIssue } from "./types.js";

export type DateSortKey = readonly [number, string];
export type SelectionOrderingKey = readonly [
  number,
  number,
  readonly [number, string],
  number,
  number,
  DateSortKey,
];

/** Within-group date tiebreak: created_at asc, else updated_at desc via complement. */
export function dateSortKey(issue: CachedIssue): DateSortKey {
  const createdAt = issue.createdAt ?? "";
  if (createdAt.length > 0) {
    return [0, createdAt];
  }
  const updatedAt = issue.updatedAt ?? "";
  if (updatedAt.length === 0) {
    return [1, "\u0000"];
  }
  const inv = [...updatedAt]
    .map((char) => {
      const code = char.charCodeAt(0);
      return String.fromCharCode(Math.max(0, 0x7f - code));
    })
    .join("");
  return [1, inv];
}

/** Canonical RFC #1419 Layer-3 lexicographic selection key. */
export function selectionOrderingKey(options: {
  readonly labelIndex: number;
  readonly isContinuation: boolean;
  readonly continuationOrder?: string;
  readonly bucketDeficit?: number | null;
  readonly rank?: number | null;
  readonly dateKey?: DateSortKey;
}): SelectionOrderingKey {
  const continuationBucket = options.isContinuation ? 0 : 1;
  let secondary: readonly [number, string];
  if (options.isContinuation) {
    const order = options.continuationOrder ?? "";
    secondary = order.length > 0 ? [0, order] : [1, ""];
  } else if (typeof options.bucketDeficit === "number" && Number.isFinite(options.bucketDeficit)) {
    secondary = [-options.bucketDeficit, ""];
  } else {
    secondary = [0, ""];
  }

  let rankBucket: number;
  let rankValue: number;
  if (typeof options.rank === "number" && Number.isInteger(options.rank)) {
    rankBucket = 0;
    rankValue = options.rank;
  } else {
    rankBucket = 1;
    rankValue = 0;
  }

  return [
    options.labelIndex,
    continuationBucket,
    secondary,
    rankBucket,
    rankValue,
    options.dateKey ?? [1, ""],
  ];
}

/** Intra-bucket sort key for a cached-issue row. */
export function withinGroupSortKey(
  issue: CachedIssue,
  rankingLabels: readonly string[],
): SelectionOrderingKey {
  let rankIndex = rankingLabels.length;
  if (rankingLabels.length > 0) {
    const labels = issue.labels ?? [];
    for (let i = 0; i < rankingLabels.length; i += 1) {
      const candidate = rankingLabels[i];
      if (candidate !== undefined && labels.includes(candidate)) {
        rankIndex = i;
        break;
      }
    }
  }

  const resolvedRank = issue._resolvedRank;
  const rank =
    typeof resolvedRank === "number" && Number.isInteger(resolvedRank) ? resolvedRank : null;

  return selectionOrderingKey({
    labelIndex: rankIndex,
    isContinuation: Boolean(issue._continuation),
    continuationOrder: String(issue._continuationOrder ?? ""),
    bucketDeficit: issue._bucketDeficit ?? null,
    rank,
    dateKey: dateSortKey(issue),
  });
}

/** Return the first ranking-label the issue matches, or null. */
export function matchedLabelFor(
  issue: CachedIssue,
  rankingLabels: readonly string[],
): string | null {
  if (rankingLabels.length === 0) {
    return null;
  }
  const labels = issue.labels ?? [];
  for (const candidate of rankingLabels) {
    if (labels.includes(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Compare two selection keys lexicographically (ascending). */
export function compareSelectionKeys(a: SelectionOrderingKey, b: SelectionOrderingKey): number {
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (Array.isArray(left) && Array.isArray(right)) {
      if (left[0] !== right[0]) {
        return left[0] < right[0] ? -1 : 1;
      }
      if (left[1] !== right[1]) {
        return left[1] < right[1] ? -1 : 1;
      }
      continue;
    }
    if (left !== right) {
      return (left as number) < (right as number) ? -1 : 1;
    }
  }
  return 0;
}
