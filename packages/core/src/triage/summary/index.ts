import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import { loadProjectDefinition, PROJECT_DEFINITION_REL_PATH } from "../../policy/resolve.js";
import { countVbriefWip, DEFAULT_WIP_CAP, resolveWipCap } from "../../policy/wip.js";
import { AUDIT_LOG_REL_PATH, latestDecisions, readAuditLog } from "../actions/candidates-log.js";
import { countReconcilable } from "./reconcilable.js";
import { computeScopeDriftTotal } from "./scope-drift.js";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export const MAX_LINE_CHARS = 120;
export { DEFAULT_WIP_CAP, PROJECT_DEFINITION_REL_PATH };
export const CACHE_DIR_NAME = ".deft-cache";
export const CACHE_SOURCE = "github-issue";
export const CANDIDATES_LOG_REL_PATH = AUDIT_LOG_REL_PATH;
export { latestDecisions, readAuditLog } from "../actions/candidates-log.js";
export const SUMMARY_HISTORY_REL_PATH = "vbrief/.eval/summary-history.jsonl";
export const SUMMARY_HISTORY_SCHEMA = "deft.triage.summary.v1";
export const EMPTY_CACHE_LINE = "[triage] cache empty -- run task triage:bootstrap";
export const WIP_LIFECYCLE_DIRS = ["pending", "active"] as const;
export const FILESYSTEM_IN_FLIGHT_FOLDER = "active";
export const FILESYSTEM_IN_FLIGHT_STATUS = "running";
export const WIP_WARN_GLYPH = "\u26a0";

export const IN_FLIGHT_DECISIONS = new Set(["accept"]);
export const TRIAGED_DECISIONS = new Set([
  "accept",
  "reject",
  "defer",
  "needs-ac",
  "mark-duplicate",
  "resume-eligible",
]);
export const STALE_DEFER_DECISIONS = new Set(["resume-eligible"]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SummaryResult {
  readonly cacheEmpty: boolean;
  readonly untriaged: number;
  readonly staleDefer: number;
  readonly inFlight: number;
  readonly wipCount: number;
  readonly wipCap: number;
  readonly repos: readonly string[];
  readonly scopeDrift: number;
  readonly inFlightFilesystem: number;
  readonly inFlightCacheScoped: number;
  readonly triageScopeConfigured: boolean;
  readonly reconcilable: number;
}

export interface ComputeSummaryOptions {
  readonly cacheRoot?: string;
  readonly auditLogPath?: string;
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/** ISO-8601 UTC with explicit `Z` suffix. */
export function utcIso(date?: Date): string {
  const moment = date ?? new Date();
  const iso = moment.toISOString();
  return iso.replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// Filesystem walkers
// ---------------------------------------------------------------------------

export function isPosIntDirName(name: string): boolean {
  if (name.length === 0) {
    return false;
  }
  for (const ch of name) {
    if (ch < "0" || ch > "9") {
      return false;
    }
  }
  return true;
}

/** Walk `<cache_root>/github-issue/<owner>/<repo>/<N>/` cache entries. */
export function iterCachedIssues(cacheRoot: string): Array<[string, number]> {
  const base = join(cacheRoot, CACHE_SOURCE);
  if (!existsSync(base)) {
    return [];
  }
  const out: Array<[string, number]> = [];
  for (const ownerEntry of readdirSync(base, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!ownerEntry.isDirectory()) {
      continue;
    }
    const ownerDir = join(base, ownerEntry.name);
    for (const repoEntry of readdirSync(ownerDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!repoEntry.isDirectory()) {
        continue;
      }
      const repo = `${ownerEntry.name}/${repoEntry.name}`;
      const repoDir = join(ownerDir, repoEntry.name);
      const issueDirs = readdirSync(repoDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && isPosIntDirName(e.name))
        .sort((a, b) => Number.parseInt(a.name, 10) - Number.parseInt(b.name, 10));
      for (const issueEntry of issueDirs) {
        const n = Number.parseInt(issueEntry.name, 10);
        if (Number.isFinite(n)) {
          out.push([repo, n]);
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// vBRIEF counters
// ---------------------------------------------------------------------------

/** Count filesystem-truth in-flight vBRIEFs (#1270). */
export function countFilesystemInFlight(projectRoot: string): number {
  const folder = join(pathResolve(projectRoot), "vbrief", FILESYSTEM_IN_FLIGHT_FOLDER);
  if (!existsSync(folder)) {
    return 0;
  }
  let total = 0;
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".vbrief.json")) {
      continue;
    }
    try {
      const data = JSON.parse(
        readFileSync(join(folder, entry.name), { encoding: "utf8" }),
      ) as unknown;
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        continue;
      }
      const plan = (data as Record<string, unknown>).plan;
      if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
        continue;
      }
      const status = (plan as Record<string, unknown>).status;
      if (status === FILESYSTEM_IN_FLIGHT_STATUS) {
        total += 1;
      }
    } catch {
      // tolerate corrupt vBRIEFs
    }
  }
  return total;
}

/** True iff `plan.policy.triageScope` is a non-empty list of dict rules. */
export function isTriageScopeExplicitlyConfigured(projectRoot: string): boolean {
  const path = join(pathResolve(projectRoot), PROJECT_DEFINITION_REL_PATH);
  if (!existsSync(path)) {
    return false;
  }
  try {
    const data = JSON.parse(readFileSync(path, { encoding: "utf8" })) as unknown;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return false;
    }
    const plan = (data as Record<string, unknown>).plan;
    if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
      return false;
    }
    const policy = (plan as Record<string, unknown>).policy;
    if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
      return false;
    }
    const scope = (policy as Record<string, unknown>).triageScope;
    if (!Array.isArray(scope) || scope.length === 0) {
      return false;
    }
    return scope.some((rule) => typeof rule === "object" && rule !== null && !Array.isArray(rule));
  } catch {
    return false;
  }
}

/** Read `plan.policy.wipCap`; always returns an integer cap. */
export function resolveWipCapInt(projectRoot: string): number {
  return resolveWipCap(projectRoot).cap;
}

function decisionKey(repo: string, issueNumber: number): string {
  return `${repo}\0${issueNumber}`;
}

// ---------------------------------------------------------------------------
// compute / format / persist
// ---------------------------------------------------------------------------

export function computeSummary(
  projectRoot: string,
  options: ComputeSummaryOptions = {},
): SummaryResult {
  const root = pathResolve(projectRoot);
  const resolvedCacheRoot = options.cacheRoot ?? join(root, CACHE_DIR_NAME);
  const resolvedLogPath = options.auditLogPath ?? join(root, CANDIDATES_LOG_REL_PATH);

  const cached = iterCachedIssues(resolvedCacheRoot);
  const repos = [...new Set(cached.map(([repo]) => repo))].sort();
  const wipCap = resolveWipCapInt(root);
  const wipCount = countVbriefWip(root);
  const inFlightFilesystem = countFilesystemInFlight(root);
  const triageScopeConfigured = isTriageScopeExplicitlyConfigured(root);

  if (cached.length === 0) {
    return {
      cacheEmpty: true,
      untriaged: 0,
      staleDefer: 0,
      inFlight: inFlightFilesystem,
      wipCount,
      wipCap,
      repos: repos.slice(0, 8),
      scopeDrift: 0,
      inFlightFilesystem,
      inFlightCacheScoped: 0,
      triageScopeConfigured,
      reconcilable: 0,
    };
  }

  const entries = readAuditLog(resolvedLogPath);
  const decisions = latestDecisions(entries);

  let untriaged = 0;
  let inFlightCacheScoped = 0;
  let staleDefer = 0;
  const noDecisionKeys: Array<[string, number]> = [];

  for (const [repo, issueNumber] of cached) {
    const decision = decisions.get(decisionKey(repo, issueNumber));
    if (decision === undefined || decision === "reset" || !TRIAGED_DECISIONS.has(decision)) {
      untriaged += 1;
    }
    if (decision === undefined) {
      noDecisionKeys.push([repo, issueNumber]);
    } else if (IN_FLIGHT_DECISIONS.has(decision)) {
      inFlightCacheScoped += 1;
    }
    if (decision !== undefined && STALE_DEFER_DECISIONS.has(decision)) {
      staleDefer += 1;
    }
  }

  const scopeDrift = computeScopeDriftTotal(root, resolvedCacheRoot);

  const repoSet = new Set(noDecisionKeys.map(([r]) => r));
  const defaultRepo = repoSet.size === 1 ? ([...repoSet][0] ?? null) : null;
  const reconcilable = countReconcilable(root, {
    defaultRepo,
    auditLogPath: resolvedLogPath,
    restrictTo: noDecisionKeys,
  });

  return {
    cacheEmpty: false,
    untriaged,
    staleDefer,
    inFlight: inFlightFilesystem,
    wipCount,
    wipCap,
    repos: repos.slice(0, 8),
    scopeDrift,
    inFlightFilesystem,
    inFlightCacheScoped,
    triageScopeConfigured,
    reconcilable,
  };
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 3) {
    return text.slice(0, maxChars);
  }
  return `${text.slice(0, maxChars - 3)}...`;
}

export function formatOneLiner(result: SummaryResult, options: { maxChars?: number } = {}): string {
  const maxChars = options.maxChars ?? MAX_LINE_CHARS;
  if (result.cacheEmpty) {
    return truncate(EMPTY_CACHE_LINE, maxChars);
  }

  const parts = [`[triage] ${result.untriaged} untriaged`];
  if (result.staleDefer >= 1) {
    parts.push(`${result.staleDefer} stale-defer (resume condition met)`);
  }
  parts.push(`${result.inFlight} in-flight`);
  let wipField = `WIP ${result.wipCount}/${result.wipCap}`;
  if (result.wipCount >= result.wipCap) {
    wipField = `${wipField} ${WIP_WARN_GLYPH}`;
  }
  parts.push(wipField);
  if (result.scopeDrift > 0) {
    parts.push(`[scope-drift] ${result.scopeDrift}`);
  }

  let candidate = parts.join(" \u00b7 ");
  if (candidate.length <= maxChars) {
    return candidate;
  }

  if (wipField.includes(WIP_WARN_GLYPH)) {
    const wipFieldNoWarn = `WIP ${result.wipCount}/${result.wipCap}`;
    const rebuilt = [...parts.slice(0, -1), wipFieldNoWarn];
    candidate = rebuilt.join(" \u00b7 ");
    if (candidate.length <= maxChars) {
      return candidate;
    }
  }

  if (result.staleDefer >= 1) {
    candidate = [
      parts[0],
      `${result.inFlight} in-flight`,
      `WIP ${result.wipCount}/${result.wipCap}`,
    ].join(" \u00b7 ");
    if (candidate.length <= maxChars) {
      return candidate;
    }
  }

  return truncate(candidate, maxChars);
}

export function formatScopeDiscrepancyLine(result: SummaryResult): string | null {
  if (result.cacheEmpty) {
    return null;
  }
  const delta = Math.abs(result.inFlightFilesystem - result.inFlightCacheScoped);
  if (delta === 0) {
    return null;
  }
  if (result.triageScopeConfigured) {
    return (
      `[triage:scope] ${delta} in-flight outside ` +
      "plan.policy.triageScope[] (uncounted in queue ranking)"
    );
  }
  return (
    `[triage:scope] ${delta} in-flight; ` +
    "plan.policy.triageScope[] not configured " +
    "(uncounted in queue ranking)"
  );
}

export function formatReconcileHintLine(result: SummaryResult): string | null {
  if (result.cacheEmpty || result.reconcilable <= 0) {
    return null;
  }
  return (
    `[triage:reconcile] ${result.reconcilable} accepted on disk but ` +
    "missing from the audit log -- run `task triage:reconcile` to restore"
  );
}

export function formatSummary(result: SummaryResult, options: { maxChars?: number } = {}): string {
  const lines = [formatOneLiner(result, options)];
  const scopeLine = formatScopeDiscrepancyLine(result);
  if (scopeLine !== null) {
    lines.push(scopeLine);
  }
  const reconcileLine = formatReconcileHintLine(result);
  if (reconcileLine !== null) {
    lines.push(reconcileLine);
  }
  return lines.join("\n");
}

export function summaryResultToRecord(
  result: SummaryResult,
  options: { emittedAt: string; line: string },
): Record<string, unknown> {
  return {
    schema: SUMMARY_HISTORY_SCHEMA,
    emitted_at: options.emittedAt,
    line: options.line,
    cache_empty: result.cacheEmpty,
    untriaged: result.untriaged,
    stale_defer: result.staleDefer,
    in_flight: result.inFlight,
    in_flight_filesystem: result.inFlightFilesystem,
    in_flight_cache_scoped: result.inFlightCacheScoped,
    triage_scope_configured: result.triageScopeConfigured,
    wip_count: result.wipCount,
    wip_cap: result.wipCap,
    repos: [...result.repos],
    scope_drift: result.scopeDrift,
    reconcilable: result.reconcilable,
  };
}

function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortKeysDeep(obj[key]);
  }
  return sorted;
}

/** Match Python `json.dumps(..., sort_keys=True, ensure_ascii=False)` spacing. */
export function pythonStyleStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => pythonStyleStringify(v)).join(", ")}]`;
  }
  const obj = sortKeysDeep(value) as Record<string, unknown>;
  const pairs = Object.keys(obj).map(
    (k) => `${JSON.stringify(k)}: ${pythonStyleStringify(obj[k])}`,
  );
  return `{${pairs.join(", ")}}`;
}

/** Append a single JSONL record to summary-history.jsonl. Never throws. */
export function appendHistory(
  historyPath: string,
  result: SummaryResult,
  line: string,
  options: { emittedAt?: string } = {},
): string {
  const record = summaryResultToRecord(result, {
    emittedAt: options.emittedAt ?? utcIso(),
    line,
  });
  const payload = pythonStyleStringify(record);
  try {
    mkdirSync(join(historyPath, ".."), { recursive: true });
    appendFileSync(historyPath, `${payload}\n`, { encoding: "utf8" });
  } catch {
    // observability only — never crash the ritual
  }
  return historyPath;
}

// Re-export loadProjectDefinition for tests that need PROJECT-DEFINITION helpers.
export { loadProjectDefinition };
