import type { QueueGroup } from "./constants.js";

/** One ranked row in buildQueue. */
export interface QueueItem {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly labels: readonly string[];
  readonly updatedAt: string;
  readonly group: QueueGroup;
  readonly latestDecision: string | null;
  readonly matchedLabel: string | null;
  readonly repo: string;
}

/** Bundled options for buildQueue. */
export interface QueueBuildOptions {
  readonly rankingLabels?: readonly string[];
  readonly activeReferenced?: ReadonlySet<number>;
  readonly orphanIssueNumbers?: ReadonlySet<number>;
  readonly rankByNumber?: ReadonlyMap<number, number>;
  readonly continuationNumbers?: ReadonlySet<number>;
  readonly continuationOrderByNumber?: ReadonlyMap<number, string>;
  readonly deficitByNumber?: ReadonlyMap<number, number>;
  readonly finishBeforeStart?: boolean;
  readonly wipAtCap?: boolean;
  readonly blockedIssueNumbers?: ReadonlySet<number>;
  readonly includeBlocked?: boolean;
  readonly limit?: number | null;
}

/** Cached issue row produced by loadCachedIssues. */
export interface CachedIssue {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly labels: readonly string[];
  readonly updatedAt: string;
  readonly createdAt: string;
  readonly metadataRank: number | null;
  readonly continuation: boolean;
  readonly continuationOrder: string;
  readonly bucketDeficit: number | null;
  readonly blocked: boolean;
  /** Mutable annotations stamped during buildQueue. */
  _latestDecision?: string | null;
  _blocked?: boolean;
  _resolvedRank?: number | null;
  _continuation?: boolean;
  _continuationOrder?: string;
  _bucketDeficit?: number | null;
}

/** Audit log entry shape (candidates.jsonl row). */
export interface AuditEntry {
  readonly timestamp?: string;
  readonly repo?: string;
  readonly issue_number?: number;
  readonly decision?: string;
  readonly [key: string]: unknown;
}
