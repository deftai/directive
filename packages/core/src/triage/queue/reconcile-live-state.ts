import { restIssueListPaginated } from "../../scm/gh-rest.js";
import type { CachedIssue } from "./types.js";

/**
 * Resolve the set of issue numbers that are currently OPEN on the live SCM.
 *
 * Returns `null` when the live state could not be determined (offline, gh
 * missing / unauthenticated, REST error). Callers MUST treat `null` as "do not
 * reconcile" and fall back to the cached view -- a transient read failure must
 * never empty the queue.
 */
export type LiveOpenIssuesReader = (repo: string) => ReadonlySet<number> | null;

/**
 * Default reader: one batched, paginated REST list (`state=open`, PRs excluded)
 * routed through the scm gh-rest shim. Prefers REST over GraphQL and issues a
 * single logical lookup for the whole open set rather than N per-issue calls.
 * Any failure is swallowed to `null` so the queue degrades to cached rendering.
 *
 * Latency ceiling: no explicit `limit` is passed ON PURPOSE. The reconcile drops
 * any candidate absent from this set, so a truncated page would incorrectly drop
 * genuinely-open issues (a false-negative is worse than the latency). The set is
 * therefore the COMPLETE live-open list, bounded only by `restIssueListPaginated`'s
 * pagination cap (`REST_PAGINATION_MAX_PAGES` * per-page = 100 * 100 = 10,000 open
 * issues); a repo with more open issues than that raises rather than silently
 * truncating. In practice open-issue counts are 10^1-10^2, so this is 1-2 REST
 * pages. Batch here, never per-candidate.
 */
export function defaultLiveOpenIssuesReader(repo: string): ReadonlySet<number> | null {
  try {
    const rows = restIssueListPaginated(repo, { state: "open", excludePulls: true });
    const open = new Set<number>();
    for (const row of rows) {
      const n = row.number;
      if (typeof n === "number" && Number.isInteger(n)) {
        open.add(n);
      }
    }
    return open;
  } catch {
    return null;
  }
}

/**
 * Reconcile cached candidate issues against live open/closed state before the
 * queue renders (#2238). The cached candidate set records `state`, but that
 * value goes stale as soon as an issue is closed/merged and the cache has not
 * yet refreshed -- so honoring the cached flag alone is insufficient.
 *
 * Drops any candidate whose number is NOT in the live-open set. When the reader
 * returns `null` (state undeterminable) the candidates pass through unchanged so
 * a network / auth failure never silently empties the queue.
 *
 * `reader` defaults to {@link defaultLiveOpenIssuesReader}; tests (and the CLI)
 * inject a stub via this optional parameter -- there is no module-level mutable
 * seam, so nothing test-only leaks into the package's public API.
 */
export function reconcileLiveOpenState(
  issues: readonly CachedIssue[],
  repo: string,
  reader: LiveOpenIssuesReader = defaultLiveOpenIssuesReader,
): readonly CachedIssue[] {
  const liveOpen = reader(repo);
  if (liveOpen === null) {
    return issues;
  }
  return issues.filter((issue) => liveOpen.has(issue.number));
}
