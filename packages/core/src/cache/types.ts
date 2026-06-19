/* v8 ignore file -- type-only interfaces; no runtime branches */
import type { ScanFlag, ScanResult } from "./scanner.js";

export interface PutResult {
  source: string;
  key: string;
  entryDir: string;
  meta: Record<string, unknown>;
  scanResult: ScanResult;
  contentWritten: boolean;
}

export interface GetResult {
  source: string;
  key: string;
  entryDir: string;
  meta: Record<string, unknown>;
  contentPath: string | null;
  stale: boolean;
}

export interface FetchAllReport {
  issuesWritten: number;
  alreadyFresh: number;
  issuesFailed: number;
  failures: Array<{ key: string; reason: string }>;
}

export interface StateRefreshReport {
  revisited: number;
  closedRewritten: number;
  stillOpen: number;
  refreshFailed: number;
  failures: Array<{ key: string; reason: string }>;
}

export interface CachePutOptions {
  ttlSeconds?: number | null;
  cacheRoot?: string;
  fetchedAt?: Date;
  caps?: import("./quota.js").CacheCaps | null;
  clock?: import("./time.js").Clock;
}

export interface CacheGetOptions {
  cacheRoot?: string;
  allowStale?: boolean;
  clock?: import("./time.js").Clock;
}

export type ScanFlagMeta = ScanFlag;
