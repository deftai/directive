import type { FetchAllReportImpl } from "../cache/fetch.js";
import type { CacheModule } from "../triage/bootstrap/types.js";

/** Adapt TS cache reports to the bootstrap `FetchAllReport` shape. */
export function bootstrapCacheModule(
  cacheFetchAll: (
    options: Parameters<typeof import("../cache/fetch.js").cacheFetchAll>[0],
  ) => FetchAllReportImpl,
): CacheModule {
  return {
    cacheFetchAll(kwargs) {
      const report = cacheFetchAll({
        source: kwargs.source,
        repo: kwargs.repo,
        batchSize: kwargs.batchSize,
        delayMs: kwargs.delayMs,
        cacheRoot: kwargs.cacheRoot,
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
