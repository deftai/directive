/**
 * empty-populate.ts -- auto-fetch GitHub when the triage cache is empty (#2575).
 *
 * Empty/missing cache is the one case where a live list beats a false-empty
 * "what's next?" answer. Non-empty caches keep the 24h freshness gate unchanged.
 */

import { join, resolve } from "node:path";
import { stepSeedCandidatesLog } from "../triage/bootstrap/gitignore.js";
import { inferRepoFromGit, stepBackfillAuditLog } from "../triage/bootstrap/index.js";
import { ENV_TRIAGE_REPO } from "../triage/queue/constants.js";
import { CACHE_DIR_NAME, CACHE_SOURCE, iterCachedIssues } from "../triage/summary/index.js";
import type { FetchAllReportImpl } from "./fetch.js";
import { cacheFetchAll } from "./fetch.js";

export interface EmptyPopulateResult {
  readonly skipped: boolean;
  readonly skipReason: string | null;
  readonly repo: string | null;
  readonly populated: boolean;
  readonly succeeded: number | null;
  readonly message: string;
}

export interface EmptyPopulateOptions {
  readonly repo?: string | null;
  readonly cacheRoot?: string;
  readonly source?: string;
  readonly inferRepoFn?: (cwd: string) => string | null;
  readonly fetchFn?: (options: {
    source: string;
    repo: string;
    cacheRoot: string;
    force: boolean;
  }) => FetchAllReportImpl;
  readonly seedFn?: (projectRoot: string) => { ok: boolean };
  readonly backfillFn?: (projectRoot: string, repo: string | null) => { ok: boolean };
}

/** True when `.deft-cache/github-issue/` has zero cached issue entries. */
export function isTriageCacheEmpty(projectRoot: string, cacheRoot?: string): boolean {
  const root = resolve(projectRoot);
  const resolvedCacheRoot = cacheRoot ?? join(root, CACHE_DIR_NAME);
  return iterCachedIssues(resolvedCacheRoot).length === 0;
}

/**
 * When the triage cache is empty, mirror `triage:bootstrap` populate steps:
 * fetch-all from GitHub, seed the candidates log, backfill lifecycle accepts.
 * Never auto-accepts new issues beyond existing xBRIEF backfill.
 */
export function maybeAutoPopulateEmptyCache(
  projectRoot: string,
  options: EmptyPopulateOptions = {},
): EmptyPopulateResult {
  const root = resolve(projectRoot);
  const source = options.source ?? CACHE_SOURCE;
  const cacheRoot = options.cacheRoot ?? join(root, CACHE_DIR_NAME);

  if (!isTriageCacheEmpty(root, cacheRoot)) {
    return {
      skipped: true,
      skipReason: "cache-non-empty",
      repo: null,
      populated: false,
      succeeded: null,
      message: "cache already populated",
    };
  }

  const infer = options.inferRepoFn ?? inferRepoFromGit;
  const envRepo = (process.env[ENV_TRIAGE_REPO] ?? "").trim();
  const repo = options.repo ?? (envRepo.length > 0 ? envRepo : null) ?? infer(root);
  if (repo === null) {
    return {
      skipped: true,
      skipReason: "repo-not-resolved",
      repo: null,
      populated: false,
      succeeded: null,
      message: "could not infer repo for empty-cache auto-populate",
    };
  }

  const fetch = options.fetchFn ?? cacheFetchAll;
  let report: FetchAllReportImpl;
  try {
    report = fetch({ source, repo, cacheRoot, force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      skipped: true,
      skipReason: "fetch-failed",
      repo,
      populated: false,
      succeeded: null,
      message,
    };
  }

  const seed = options.seedFn ?? stepSeedCandidatesLog;
  const seedOutcome = seed(root);
  if (!seedOutcome.ok) {
    return {
      skipped: true,
      skipReason: "seed-failed",
      repo,
      populated: false,
      succeeded: report.issuesWritten,
      message: "candidates log seed failed after fetch-all",
    };
  }

  const backfill = options.backfillFn ?? stepBackfillAuditLog;
  try {
    const backfillOutcome = backfill(root, repo);
    if (!backfillOutcome.ok) {
      return {
        skipped: true,
        skipReason: "backfill-failed",
        repo,
        populated: false,
        succeeded: report.issuesWritten,
        message: "audit log backfill failed after fetch-all",
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      skipped: true,
      skipReason: "backfill-failed",
      repo,
      populated: false,
      succeeded: report.issuesWritten,
      message,
    };
  }

  return {
    skipped: false,
    skipReason: null,
    repo,
    populated: true,
    succeeded: report.issuesWritten,
    message: `auto-populated empty triage cache from GitHub (${repo})`,
  };
}

/** Idempotent hydrate hook for triage read paths (#2575). */
export function ensureTriageCacheHydrated(
  projectRoot: string,
  options: EmptyPopulateOptions = {},
): EmptyPopulateResult {
  return maybeAutoPopulateEmptyCache(projectRoot, options);
}
