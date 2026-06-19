import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractIssueRefs, iterActiveVbriefs } from "./extract.js";
import { CACHE_SOURCE, type DriftRecord } from "./types.js";

export type FetchLive = (repo: string, issueNumber: number) => string;
export type CacheLoader = (repo: string, issueNumber: number, projectRoot: string) => string | null;

/** Return true iff live timestamp postdates cached fetch. */
export function isDrift(cachedFetchedAt: string | null, liveUpdatedAt: string): boolean {
  if (!liveUpdatedAt) return false;
  if (cachedFetchedAt === null) return true;
  return liveUpdatedAt > cachedFetchedAt;
}

export function loadCachedFetchedAt(
  repo: string,
  issueNumber: number,
  projectRoot: string,
): string | null {
  const key = `${repo}/${issueNumber}`;
  const parts = key.split("/");
  if (parts.length < 3) return null;
  const owner = parts[0];
  const repoName = parts[1];
  const num = parts[2];
  const metaPath = join(
    projectRoot,
    ".deft-cache",
    CACHE_SOURCE,
    owner ?? "",
    repoName ?? "",
    num ?? "",
    "meta.json",
  );
  if (!existsSync(metaPath)) return null;
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as unknown;
    if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
    const fetchedAt = (meta as Record<string, unknown>).fetched_at;
    return fetchedAt !== undefined && fetchedAt !== null ? String(fetchedAt) : null;
  } catch {
    return null;
  }
}

export interface DetectDriftOptions {
  readonly fetchLive?: FetchLive;
  readonly cacheLoader?: CacheLoader;
  readonly skippedOut?: Array<[string, number, string]>;
  readonly checkedOut?: Array<[string, number]>;
  readonly log?: (line: string) => void;
}

export function detectDrift(
  activeDir: string,
  projectRoot: string,
  options: DetectDriftOptions = {},
): DriftRecord[] {
  const fetchLive = options.fetchLive ?? (() => "");
  const cacheLoader = options.cacheLoader ?? loadCachedFetchedAt;
  const log = options.log ?? (() => {});

  const drifts: DriftRecord[] = [];
  const seen = new Set<string>();

  for (const vbrief of iterActiveVbriefs(activeDir)) {
    for (const [repo, num] of extractIssueRefs(vbrief)) {
      const key = `${repo}#${num}`;
      if (seen.has(key)) continue;
      seen.add(key);
      options.checkedOut?.push([repo, num]);
      const cached = cacheLoader(repo, num, projectRoot);
      let live: string;
      try {
        live = fetchLive(repo, num);
      } catch (err) {
        const reason = `${err instanceof Error ? err.constructor.name : "Error"}: ${String(err)}`;
        log(`[triage:refresh-active] WARN: live fetch skipped for ${repo}#${num} (${reason})`);
        options.skippedOut?.push([repo, num, reason]);
        continue;
      }
      if (isDrift(cached, live)) {
        drifts.push({
          repo,
          issueNumber: num,
          cachedFetchedAt: cached,
          liveUpdatedAt: live,
          vbriefPath: vbrief,
        });
      }
    }
  }
  return drifts;
}
