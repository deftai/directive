export interface DriftRecord {
  readonly repo: string;
  readonly issueNumber: number;
  readonly cachedFetchedAt: string | null;
  readonly liveUpdatedAt: string;
  readonly vbriefPath: string;
}

export interface FreshnessSummary {
  readonly totalActive: number;
  readonly driftsDetected: number;
  readonly proceeded: Array<[string, number]>;
  readonly refreshed: Array<[string, number]>;
  readonly deferred: Array<[string, number]>;
  readonly skipped: Array<[string, number]>;
}

export const PROMPT_OPTIONS: Readonly<Record<string, string>> = {
  "1": "proceed-with-stale",
  "2": "refresh-and-update-local",
  "3": "defer-from-this-batch",
};

export const CACHE_SOURCE = "github-issue";
