import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GhRestError,
  InvalidRepoError,
  type RunGhApiFn,
  restIssueView,
  runGhApi,
} from "../scm/gh-rest.js";
import { DEFAULT_BATCH_SIZE, DEFAULT_DELAY_MS } from "./constants.js";
import { CacheError, CacheFetchError } from "./errors.js";
import { pythonJsonLine } from "./json.js";
import { cachePut, isFresh, validateRepo } from "./operations.js";
import { entryDir } from "./paths.js";
import type { FetchAllReport, StateRefreshReport } from "./types.js";

export const REST_MAX_PER_PAGE = 100;
export const REST_PAGINATION_MAX_PAGES = 100;
export const DEFAULT_RETRY_AFTER_FALLBACK_S = 60;
export const PROGRESS_EVERY_N = 50;

const RATE_LIMIT_RE = /(?:HTTP\s*429|API rate limit exceeded|rate limit exceeded)/i;
const RETRY_AFTER_RE = /Retry-After:\s*(\d+)/i;

export type PaginatedLister = (
  repo: string,
  options?: {
    state?: string;
    labels?: readonly string[];
    author?: string | null;
    perPage?: number;
    limit?: number;
    excludePulls?: boolean;
    runGhApiFn?: RunGhApiFn;
  },
) => Array<Record<string, unknown>>;

export type SleepFn = (seconds: number) => void;
export type ProgressWriter = (line: string) => void;

let paginatedListerImpl: PaginatedLister = restIssueListPaginated;
let sleepImpl: SleepFn = () => {};
let progressWriterImpl: ProgressWriter = (line) => process.stderr.write(line);
let progressFlusherImpl: () => void = () => {};
let singleIssueFetcherImpl: (repo: string, n: number) => Record<string, unknown> = restIssueView;

export function setSingleIssueFetcher(
  fn: (repo: string, n: number) => Record<string, unknown>,
): void {
  singleIssueFetcherImpl = fn;
}

export function setPaginatedLister(fn: PaginatedLister): void {
  paginatedListerImpl = fn;
}

export function setSleepFn(fn: SleepFn): void {
  sleepImpl = fn;
}

export function setProgressWriter(fn: ProgressWriter, flusher?: () => void): void {
  progressWriterImpl = fn;
  progressFlusherImpl = flusher ?? (() => {});
}

export function detectRateLimit(stderr: string): [boolean, number] {
  if (!stderr || !RATE_LIMIT_RE.test(stderr)) {
    return [false, DEFAULT_RETRY_AFTER_FALLBACK_S];
  }
  const m = RETRY_AFTER_RE.exec(stderr);
  if (m?.[1]) {
    const n = Number.parseInt(m[1], 10);
    if (!Number.isNaN(n)) return [true, n];
  }
  return [true, DEFAULT_RETRY_AFTER_FALLBACK_S];
}

function execListPage(
  repo: string,
  page: number,
  options: {
    state: string;
    labels: readonly string[];
    author: string | null;
    perPage: number;
    runGhApiFn?: RunGhApiFn;
  },
): Record<string, unknown>[] {
  const parts = repo.split("/");
  const owner = parts[0] ?? "";
  const name = parts[1] ?? "";
  const endpoint = `repos/${owner}/${name}/issues`;
  const args: string[] = [endpoint, "--method", "GET", "--raw-field", `state=${options.state}`];
  args.push("--raw-field", `per_page=${options.perPage}`);
  args.push("--raw-field", `page=${page}`);
  if (options.labels.length > 0) {
    args.push("--raw-field", `labels=${options.labels.join(",")}`);
  }
  if (options.author) {
    args.push("--raw-field", `creator=${options.author}`);
  }
  const runner = options.runGhApiFn ?? runGhApi;
  const result = runner(args);
  if (result.returncode !== 0) {
    throw new GhRestError({
      stderr: result.stderr.trim(),
      exitCode: result.returncode,
      endpoint,
      payload: null,
    });
  }
  const stdout = result.stdout.trim();
  if (!stdout) return [];
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) {
    throw new GhRestError({
      stderr: `unexpected top-level type ${typeof parsed}`,
      exitCode: 0,
      endpoint,
      payload: null,
      hint: "REST endpoint returned non-list; expected list",
    });
  }
  return parsed as Record<string, unknown>[];
}

export function restIssueListPaginated(
  repo: string,
  options: {
    state?: string;
    labels?: readonly string[];
    author?: string | null;
    perPage?: number;
    limit?: number;
    excludePulls?: boolean;
    runGhApiFn?: RunGhApiFn;
  } = {},
): Record<string, unknown>[] {
  const cappedPerPage = Math.min(
    Math.max(1, options.perPage ?? REST_MAX_PER_PAGE),
    REST_MAX_PER_PAGE,
  );
  const state = options.state ?? "open";
  const labels = options.labels ?? [];
  const author = options.author ?? null;
  const excludePulls = options.excludePulls ?? true;
  const limit = options.limit;
  const out: Record<string, unknown>[] = [];

  for (let page = 1; page <= REST_PAGINATION_MAX_PAGES; page += 1) {
    const pagePayload = execListPage(repo, page, {
      state,
      labels,
      author,
      perPage: cappedPerPage,
      runGhApiFn: options.runGhApiFn,
    });
    if (pagePayload.length === 0) return out;
    for (const item of pagePayload) {
      if (excludePulls && "pull_request" in item) continue;
      out.push(item);
      if (limit !== undefined && out.length >= limit) return out.slice(0, limit);
    }
    if (pagePayload.length < cappedPerPage) return out;
  }
  throw new GhRestError({
    stderr: `pagination exceeded REST_PAGINATION_MAX_PAGES=${REST_PAGINATION_MAX_PAGES}`,
    exitCode: 0,
    endpoint: `repos/${repo}/issues`,
    payload: null,
    hint: "pass an explicit `limit` to bound the run",
  });
}

function normaliseRestIssue(raw: Record<string, unknown>): Record<string, unknown> {
  const out = { ...raw };
  const state = out.state;
  if (typeof state === "string") out.state = state.toLowerCase();
  return out;
}

export class FetchAllReportImpl implements FetchAllReport {
  issuesWritten = 0;
  alreadyFresh = 0;
  issuesFailed = 0;
  failures: Array<{ key: string; reason: string }> = [];

  toJson(): string {
    return pythonJsonLine({
      already_fresh: this.alreadyFresh,
      failed: this.issuesFailed,
      failures: this.failures,
      issues_failed: this.issuesFailed,
      issues_written: this.issuesWritten,
      skipped: this.alreadyFresh,
      succeeded: this.issuesWritten,
    });
  }

  summaryLine(source: string, repo: string): string {
    return (
      `cache:fetch-all source=${source} repo=${repo} ` +
      `issues_written=${this.issuesWritten} ` +
      `already_fresh=${this.alreadyFresh} ` +
      `issues_failed=${this.issuesFailed}`
    );
  }
}

function maybeSleep(delayMs: number): void {
  if (delayMs > 0) sleepImpl(delayMs / 1000);
}

function emitFetchProgress(
  repo: string,
  phase: string,
  processed: number,
  total: number,
  report: FetchAllReportImpl,
): void {
  const line =
    phase === "enumerated"
      ? `cache:fetch-all progress repo=${repo} enumerated=${total} issues; writing cache entries...\n`
      : `cache:fetch-all progress repo=${repo} processed=${processed}/${total} ` +
        `issues_written=${report.issuesWritten} already_fresh=${report.alreadyFresh} ` +
        `issues_failed=${report.issuesFailed}\n`;
  try {
    progressWriterImpl(line);
    progressFlusherImpl();
  } catch {
    /* best-effort */
  }
}

function listIssuesRest(
  repo: string,
  options: { state: string; limit: number; labels: readonly string[]; author: string | null },
): Record<string, unknown>[] {
  const filterOpts: Parameters<PaginatedLister>[1] = {
    state: options.state,
    limit: options.limit,
  };
  if (options.labels.length > 0) filterOpts.labels = options.labels;
  if (options.author !== null) filterOpts.author = options.author;
  try {
    return paginatedListerImpl(repo, filterOpts);
  } catch (err) {
    if (err instanceof InvalidRepoError) {
      throw new CacheFetchError(
        `invalid --repo '${repo}' for REST list enumeration: ${err.message}`,
      );
    }
    if (err instanceof GhRestError) {
      const [is429, retryAfter] = detectRateLimit(String(err) || err.stderr || "");
      if (!is429) {
        throw new CacheFetchError(
          `rest_issue_list_paginated failed for repo=${repo}: ${err.message}`,
        );
      }
      progressWriterImpl(
        `cache:fetch-all rate-limited on enumeration (${repo}); sleeping ${retryAfter}s before retry\n`,
      );
      sleepImpl(retryAfter);
      try {
        return paginatedListerImpl(repo, filterOpts);
      } catch (err2) {
        throw new CacheFetchError(
          `rest_issue_list_paginated failed twice for repo=${repo}: ${err2 instanceof Error ? err2.message : String(err2)}`,
        );
      }
    }
    throw err;
  }
}

export function runFetchAll(options: {
  repo: string;
  source: string;
  cacheRoot?: string;
  batchSize?: number;
  delayMs?: number;
  ttlSeconds?: number | null;
  state?: string;
  limit?: number;
  labels?: readonly string[];
  author?: string | null;
  isFresh?: (metaPath: string) => boolean;
  doPut?: (key: string, raw: Record<string, unknown>) => void;
}): FetchAllReportImpl {
  const issues = listIssuesRest(options.repo, {
    state: options.state ?? "open",
    limit: options.limit ?? 1000,
    labels: options.labels ?? [],
    author: options.author ?? null,
  });
  const report = new FetchAllReportImpl();
  const total = issues.length;
  const cacheRoot = options.cacheRoot ?? ".deft-cache";
  const source = options.source;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const ttlSeconds = options.ttlSeconds;
  const isFreshFn = options.isFresh ?? ((metaPath: string) => isFresh(metaPath));
  const doPutFn =
    options.doPut ??
    ((key: string, raw: Record<string, unknown>) => {
      cachePut(source, key, raw, { ttlSeconds, cacheRoot });
    });

  if (total >= PROGRESS_EVERY_N) {
    emitFetchProgress(options.repo, "enumerated", 0, total, report);
  }

  for (let i = 0; i < issues.length; i += 1) {
    const processed = i + 1;
    const raw = normaliseRestIssue(issues[i] ?? {});
    const number = raw.number;
    if (typeof number !== "number" || number <= 0) {
      report.issuesFailed += 1;
      report.failures.push({
        key: `${options.repo}/?`,
        reason: `invalid 'number' field: ${JSON.stringify(number)}`,
      });
    } else {
      const key = `${options.repo}/${number}`;
      const edir = entryDir(source, key, cacheRoot);
      if (isFreshFn(join(edir, "meta.json"))) {
        report.alreadyFresh += 1;
      } else {
        try {
          doPutFn(key, raw);
          report.issuesWritten += 1;
        } catch (exc) {
          report.issuesFailed += 1;
          report.failures.push({
            key,
            reason: exc instanceof Error ? exc.message : String(exc),
          });
        }
      }
    }

    if (total >= PROGRESS_EVERY_N && (processed % PROGRESS_EVERY_N === 0 || processed === total)) {
      emitFetchProgress(options.repo, "writing", processed, total, report);
    }
    maybeSleep(delayMs);
    if (processed % batchSize === 0) maybeSleep(delayMs);
  }
  return report;
}

export function cacheFetchAll(options: {
  source: string;
  repo: string;
  batchSize?: number;
  delayMs?: number;
  ttlSeconds?: number | null;
  state?: string;
  limit?: number;
  labels?: readonly string[];
  author?: string | null;
  cacheRoot?: string;
}): FetchAllReportImpl {
  if (options.source !== "github-issue") {
    throw new CacheError(
      `cache:fetch-all source='${options.source}' not supported in v1 (supports: github-issue only; other sources deferred to v2)`,
    );
  }
  validateRepo(options.repo);
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  if (batchSize < 1) {
    throw new CacheError(`--batch-size must be >= 1 (got ${JSON.stringify(batchSize)})`);
  }
  if (delayMs < 0) {
    throw new CacheError(`--delay-ms must be >= 0 (got ${JSON.stringify(delayMs)})`);
  }
  return runFetchAll({
    repo: options.repo,
    source: options.source,
    cacheRoot: options.cacheRoot,
    batchSize,
    delayMs,
    ttlSeconds: options.ttlSeconds,
    state: options.state,
    limit: options.limit,
    labels: options.labels,
    author: options.author,
  });
}

export class StateRefreshReportImpl implements StateRefreshReport {
  revisited = 0;
  closedRewritten = 0;
  stillOpen = 0;
  refreshFailed = 0;
  failures: Array<{ key: string; reason: string }> = [];

  toJson(): string {
    return pythonJsonLine({
      closed_rewritten: this.closedRewritten,
      failures: this.failures,
      refresh_failed: this.refreshFailed,
      revisited: this.revisited,
      still_open: this.stillOpen,
    });
  }
}

export function listOpenIssueNumbers(
  repo: string,
  options: { state?: string; limit?: number } = {},
): Set<number> {
  const issues = listIssuesRest(repo, {
    state: options.state ?? "open",
    limit: options.limit ?? 1000,
    labels: [],
    author: null,
  });
  const numbers = new Set<number>();
  for (const issue of issues) {
    const number = issue.number;
    if (typeof number === "number" && number > 0) numbers.add(number);
  }
  return numbers;
}

export function runStateRefresh(options: {
  repo: string;
  openNumbers: Set<number>;
  cachedOpen: Array<[number, Record<string, unknown>]>;
  doPut: (key: string, raw: Record<string, unknown>) => void;
  fetchSingle?: (repo: string, n: number) => Record<string, unknown>;
  delayMs?: number;
}): StateRefreshReportImpl {
  const fetcher = options.fetchSingle ?? restIssueView;
  const report = new StateRefreshReportImpl();
  const delayMs = options.delayMs ?? 0;
  for (const [number] of options.cachedOpen) {
    if (options.openNumbers.has(number)) continue;
    report.revisited += 1;
    const key = `${options.repo}/${number}`;
    try {
      const live = fetcher(options.repo, number);
      const liveStateRaw = live.state;
      const liveState = typeof liveStateRaw === "string" ? liveStateRaw.toLowerCase() : null;
      if (liveState === "closed") {
        try {
          options.doPut(key, normaliseRestIssue(live));
          report.closedRewritten += 1;
        } catch (exc) {
          report.refreshFailed += 1;
          report.failures.push({
            key,
            reason: `rewrite failed: ${exc instanceof Error ? exc.message : String(exc)}`,
          });
        }
      } else {
        report.stillOpen += 1;
      }
    } catch (exc) {
      report.refreshFailed += 1;
      report.failures.push({
        key,
        reason: `fetch failed: ${exc instanceof Error ? exc.message : String(exc)}`,
      });
    }
    maybeSleep(delayMs);
  }
  return report;
}

export function scanCachedOpenEntries(
  repo: string,
  source: string,
  cacheRoot: string,
): Array<[number, Record<string, unknown>]> {
  if (!repo.includes("/")) return [];
  const parts = repo.split("/", 2);
  const owner = parts[0];
  const name = parts[1];
  if (owner === undefined || name === undefined) return [];
  const base = join(cacheRoot, source, owner, name);
  if (!existsSync(base)) return [];
  const out: Array<[number, Record<string, unknown>]> = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const n = Number.parseInt(entry.name, 10);
    if (Number.isNaN(n) || n <= 0) continue;
    const rawPath = join(base, entry.name, "raw.json");
    if (!existsSync(rawPath)) continue;
    try {
      const raw = JSON.parse(readFileSync(rawPath, "utf8")) as Record<string, unknown>;
      const stateRaw = raw.state;
      const state = typeof stateRaw === "string" ? stateRaw.toLowerCase() : "";
      if (state === "open") out.push([n, raw]);
    } catch {
      /* skip corrupt */
    }
  }
  return out;
}

export function cacheRefreshClosed(options: {
  source: string;
  repo: string;
  ttlSeconds?: number | null;
  delayMs?: number;
  limit?: number;
  cacheRoot?: string;
  openNumbers?: Set<number>;
  listOpenFn?: (repo: string, limit: number) => Set<number>;
}): StateRefreshReportImpl {
  const cacheRoot = options.cacheRoot ?? ".deft-cache";
  const cachedOpen = scanCachedOpenEntries(options.repo, options.source, cacheRoot);
  const limit = options.limit ?? 1000;
  const openNumbers =
    options.openNumbers ??
    (options.listOpenFn ?? ((repo, listLimit) => listOpenIssueNumbers(repo, { limit: listLimit })))(
      options.repo,
      limit,
    );
  return runStateRefresh({
    repo: options.repo,
    openNumbers,
    cachedOpen,
    delayMs: options.delayMs ?? DEFAULT_DELAY_MS,
    fetchSingle: singleIssueFetcherImpl,
    doPut: (key, raw) => {
      cachePut(options.source, key, raw, {
        ttlSeconds: options.ttlSeconds,
        cacheRoot,
      });
    },
  });
}

export const DEFAULT_SELF_HEAL_TTL_SECONDS = 3600;
export const SELF_HEAL_STATE_FILENAME = "self-heal-state.json";
export const DEFAULT_MAX_CONTENT_DRIFT_CHECKS = 25;

export interface CacheDriftProbeResult {
  readonly stateDriftNumbers: readonly number[];
  readonly contentDriftNumbers: readonly number[];
}

function issueContentFingerprint(raw: Record<string, unknown>): string {
  const labels = ((raw.labels as Array<Record<string, unknown>> | undefined) ?? [])
    .map((label) => String(label.name ?? ""))
    .filter(Boolean)
    .sort();
  return JSON.stringify({
    body: raw.body ?? "",
    labels,
    state: typeof raw.state === "string" ? raw.state.toLowerCase() : raw.state,
    title: raw.title ?? "",
  });
}

function scanCacheForSingleRepo(cacheRoot: string, source: string): string | null {
  const base = join(cacheRoot, source);
  if (!existsSync(base)) return null;
  const pairs: Array<[string, string]> = [];
  for (const ownerEntry of readdirSync(base, { withFileTypes: true })) {
    if (!ownerEntry.isDirectory()) continue;
    const ownerDir = join(base, ownerEntry.name);
    try {
      for (const repoEntry of readdirSync(ownerDir, { withFileTypes: true })) {
        if (!repoEntry.isDirectory()) continue;
        pairs.push([ownerEntry.name, repoEntry.name]);
      }
    } catch {
      /* skip */
    }
  }
  if (pairs.length === 1 && pairs[0]) {
    return `${pairs[0][0]}/${pairs[0][1]}`;
  }
  return null;
}

/** Diff cached-open issue numbers vs the live open set and TTL-fresh content drift. */
export function probeCacheDrift(options: {
  repo: string;
  source?: string;
  cacheRoot?: string;
  limit?: number;
  includeContentDrift?: boolean;
  maxContentDriftChecks?: number;
  listOpenFn?: (repo: string, limit: number) => Set<number>;
  fetchSingleFn?: (repo: string, n: number) => Record<string, unknown>;
  isFreshFn?: (metaPath: string) => boolean;
}): CacheDriftProbeResult {
  const source = options.source ?? "github-issue";
  const cacheRoot = options.cacheRoot ?? ".deft-cache";
  const limit = options.limit ?? 1000;
  const includeContentDrift = options.includeContentDrift !== false;
  const maxContentDriftChecks = options.maxContentDriftChecks ?? DEFAULT_MAX_CONTENT_DRIFT_CHECKS;
  const listOpen =
    options.listOpenFn ??
    ((repo: string, listLimit: number) => listOpenIssueNumbers(repo, { limit: listLimit }));
  const fetchSingle = options.fetchSingleFn ?? singleIssueFetcherImpl;
  const isFreshFn = options.isFreshFn ?? ((metaPath: string) => isFresh(metaPath));

  const cachedOpen = scanCachedOpenEntries(options.repo, source, cacheRoot);
  const liveOpen = listOpen(options.repo, limit);
  const stateDriftNumbers: number[] = [];
  const contentDriftNumbers: number[] = [];
  let contentChecks = 0;

  for (const [number, cachedRaw] of cachedOpen) {
    if (!liveOpen.has(number)) {
      stateDriftNumbers.push(number);
      continue;
    }
    if (!includeContentDrift || contentChecks >= maxContentDriftChecks) continue;
    const parts = options.repo.split("/", 2);
    const owner = parts[0] ?? "";
    const name = parts[1] ?? "";
    const metaPath = join(cacheRoot, source, owner, name, String(number), "meta.json");
    if (!isFreshFn(metaPath)) continue;
    contentChecks += 1;
    try {
      const live = normaliseRestIssue(fetchSingle(options.repo, number));
      if (issueContentFingerprint(cachedRaw) !== issueContentFingerprint(live)) {
        contentDriftNumbers.push(number);
      }
    } catch {
      /* probe best-effort */
    }
  }

  stateDriftNumbers.sort((a, b) => a - b);
  contentDriftNumbers.sort((a, b) => a - b);
  return { stateDriftNumbers, contentDriftNumbers };
}

export interface SelfHealResult {
  readonly skipped: boolean;
  readonly skipReason: string | null;
  readonly drift: CacheDriftProbeResult | null;
  readonly refresh: StateRefreshReportImpl | null;
}

function readSelfHealState(cacheRoot: string): Date | null {
  const path = join(cacheRoot, SELF_HEAL_STATE_FILENAME);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (raw.length === 0) return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const stamp = (parsed as Record<string, unknown>).last_reconcile_at;
    if (typeof stamp !== "string") return null;
    const parsedDate = new Date(stamp);
    return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
  } catch {
    return null;
  }
}

function writeSelfHealState(cacheRoot: string, when: Date): void {
  const path = join(cacheRoot, SELF_HEAL_STATE_FILENAME);
  writeFileSync(path, `${JSON.stringify({ last_reconcile_at: when.toISOString() })}\n`, "utf8");
}

/** TTL-bounded closed-reconcile for session ritual / triage:welcome self-healing (#1886). */
export function maybeSelfHealCache(
  projectRoot: string,
  options: {
    repo?: string | null;
    source?: string;
    cacheRoot?: string;
    ttlSeconds?: number;
    nowFn?: () => Date;
    listOpenFn?: (repo: string, limit: number) => Set<number>;
    fetchSingleFn?: (repo: string, n: number) => Record<string, unknown>;
    refreshFn?: (opts: {
      source: string;
      repo: string;
      cacheRoot: string;
      openNumbers: Set<number>;
    }) => StateRefreshReportImpl;
    writeState?: boolean;
  } = {},
): SelfHealResult {
  const source = options.source ?? "github-issue";
  const cacheRoot = options.cacheRoot ?? join(projectRoot, ".deft-cache");
  const now = options.nowFn?.() ?? new Date();
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_SELF_HEAL_TTL_SECONDS;
  const repo = options.repo ?? scanCacheForSingleRepo(cacheRoot, source);

  if (repo === null) {
    return { skipped: true, skipReason: "repo-not-resolved", drift: null, refresh: null };
  }

  const lastHeal = readSelfHealState(cacheRoot);
  const ttlExpired = lastHeal === null || now.getTime() - lastHeal.getTime() >= ttlSeconds * 1000;
  if (!ttlExpired) {
    return { skipped: true, skipReason: "ttl-fresh-no-drift", drift: null, refresh: null };
  }

  const limit = 1000;
  const listOpen =
    options.listOpenFn ??
    ((repo: string, listLimit: number) => listOpenIssueNumbers(repo, { limit: listLimit }));
  let openNumbers: Set<number>;
  try {
    openNumbers = listOpen(repo, limit);
  } catch {
    return { skipped: true, skipReason: "drift-probe-failed", drift: null, refresh: null };
  }

  let drift: CacheDriftProbeResult;
  try {
    drift = probeCacheDrift({
      repo,
      source,
      cacheRoot,
      limit,
      listOpenFn: () => openNumbers,
      fetchSingleFn: options.fetchSingleFn,
      includeContentDrift: false,
    });
  } catch {
    return { skipped: true, skipReason: "drift-probe-failed", drift: null, refresh: null };
  }

  const refreshFn =
    options.refreshFn ??
    ((opts) =>
      cacheRefreshClosed({
        source: opts.source,
        repo: opts.repo,
        cacheRoot: opts.cacheRoot,
        openNumbers: opts.openNumbers,
      }));

  try {
    const refresh = refreshFn({ source, repo, cacheRoot, openNumbers });
    if (options.writeState !== false && refresh.refreshFailed === 0) {
      writeSelfHealState(cacheRoot, now);
    }
    return { skipped: false, skipReason: null, drift, refresh };
  } catch {
    return { skipped: true, skipReason: "refresh-failed", drift, refresh: null };
  }
}
