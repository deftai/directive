/**
 * TypeScript default cache module for triage:bootstrap (#2684).
 *
 * npm / packaged consumers never ship scripts/cache.py; bootstrap must use the
 * same cacheFetchAll path as empty-cache auto-populate (#2575).
 */

import { cacheFetchAll, type FetchAllReportImpl } from "../../cache/fetch.js";
import type { CacheFetchAllKwargs, CacheModule } from "./types.js";

export type CacheFetchAllFn = (options: {
  source: string;
  repo: string;
  batchSize?: number;
  delayMs?: number;
  state?: string;
  limit?: number;
  labels?: readonly string[];
  author?: string | null;
  cacheRoot?: string;
  force?: boolean;
}) => FetchAllReportImpl;

/** Adapt TS cache reports to the bootstrap `FetchAllReport` shape. */
export function bootstrapCacheModule(fetchAll: CacheFetchAllFn = cacheFetchAll): CacheModule {
  return {
    cacheFetchAll(kwargs: CacheFetchAllKwargs) {
      const report = fetchAll({
        source: kwargs.source,
        repo: kwargs.repo,
        cacheRoot: kwargs.cacheRoot,
        force: true,
        ...(kwargs.batchSize !== undefined ? { batchSize: kwargs.batchSize } : {}),
        ...(kwargs.delayMs !== undefined ? { delayMs: kwargs.delayMs } : {}),
        ...(kwargs.state !== undefined ? { state: kwargs.state } : {}),
        ...(kwargs.limit !== undefined ? { limit: kwargs.limit } : {}),
        ...(kwargs.labels !== undefined && kwargs.labels.length > 0
          ? { labels: kwargs.labels }
          : {}),
        ...(kwargs.author !== undefined ? { author: kwargs.author } : {}),
      });
      return Promise.resolve({
        succeeded: report.issuesWritten,
        failed: report.issuesFailed,
        skipped: report.alreadyFresh,
        summaryLine: (source: string, repo: string) => report.summaryLine(source, repo),
      });
    },
  };
}

/** Default module for packaged and source checkouts — never gates on Python. */
export function loadDefaultCacheModule(): CacheModule {
  return bootstrapCacheModule();
}
