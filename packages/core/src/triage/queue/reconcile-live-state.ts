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

let readerImpl: LiveOpenIssuesReader = defaultLiveOpenIssuesReader;

/** Override the module-level live-open reader (test seam; mirrors cache/fetch). */
export function setLiveOpenIssuesReader(fn: LiveOpenIssuesReader): void {
  readerImpl = fn;
}

/** Restore the default REST-backed live-open reader. */
export function resetLiveOpenIssuesReader(): void {
  readerImpl = defaultLiveOpenIssuesReader;
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
 */
export function reconcileLiveOpenState(
  issues: readonly CachedIssue[],
  repo: string,
  reader: LiveOpenIssuesReader = readerImpl,
): readonly CachedIssue[] {
  const liveOpen = reader(repo);
  if (liveOpen === null) {
    return issues;
  }
  return issues.filter((issue) => liveOpen.has(issue.number));
}
