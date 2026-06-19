import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { countVbriefWip, DEFAULT_WIP_CAP, resolveWipCap } from "../../policy/wip.js";
import { countReconcilable } from "../reconcile/reconcile.js";
import { computeDrift } from "../scope-drift/compute.js";
import {
  CACHE_DIR_NAME,
  CACHE_SOURCE,
  EMPTY_CACHE_LINE,
  MAX_LINE_CHARS,
  SUMMARY_HISTORY_REL_PATH,
  SUMMARY_HISTORY_SCHEMA,
  WIP_WARN_GLYPH,
} from "./constants.js";

const CANDIDATES_LOG_REL_PATH = "vbrief/.eval/candidates.jsonl";
const FILESYSTEM_IN_FLIGHT_STATUS = "running";
const TRIAGED_DECISIONS = new Set([
  "accept",
  "reject",
  "defer",
  "needs-ac",
  "mark-duplicate",
  "resume-eligible",
]);
const IN_FLIGHT_DECISIONS = new Set(["accept"]);
const STALE_DEFER_DECISIONS = new Set(["resume-eligible"]);

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

function iterCachedIssues(cacheRoot: string): Array<[string, number]> {
  const base = join(cacheRoot, CACHE_SOURCE);
  if (!existsSync(base)) return [];
  const out: Array<[string, number]> = [];
  for (const owner of readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const ownerPath = join(base, owner.name);
    for (const repo of readdirSync(ownerPath, { withFileTypes: true }).filter((d) =>
      d.isDirectory(),
    )) {
      const repoPath = join(ownerPath, repo.name);
      const repoSlug = `${owner.name}/${repo.name}`;
      for (const issue of readdirSync(repoPath, { withFileTypes: true }).filter(
        (d) => d.isDirectory() && /^\d+$/.test(d.name),
      )) {
        out.push([repoSlug, Number(issue.name)]);
      }
    }
  }
  return out.sort(([aR, aN], [bR, bN]) => aR.localeCompare(bR) || aN - bN);
}

function readAuditLog(logPath: string): Array<Record<string, unknown>> {
  if (!existsSync(logPath)) return [];
  let text: string;
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const raw of text.split("\n")) {
    const stripped = raw.trim();
    if (!stripped) continue;
    try {
      const obj = JSON.parse(stripped) as unknown;
      if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
        out.push(obj as Record<string, unknown>);
      }
    } catch {}
  }
  return out;
}

function latestDecisions(entries: Array<Record<string, unknown>>): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of entries) {
    const repo = entry.repo;
    const num = entry.issue_number;
    const decision = entry.decision;
    if (typeof repo === "string" && typeof num === "number" && typeof decision === "string") {
      out.set(`${repo}:${num}`, decision);
    }
  }
  return out;
}

function countFilesystemInFlight(projectRoot: string): number {
  const activeDir = join(resolve(projectRoot), "vbrief", "active");
  if (!existsSync(activeDir)) return 0;
  let count = 0;
  for (const name of readdirSync(activeDir)) {
    if (!name.endsWith(".vbrief.json")) continue;
    try {
      const data = JSON.parse(readFileSync(join(activeDir, name), "utf8")) as Record<
        string,
        unknown
      >;
      const plan = data.plan;
      if (typeof plan === "object" && plan !== null && !Array.isArray(plan)) {
        if ((plan as Record<string, unknown>).status === FILESYSTEM_IN_FLIGHT_STATUS) count += 1;
      }
    } catch {}
  }
  return count;
}

function isTriageScopeConfigured(projectRoot: string): boolean {
  const path = join(resolve(projectRoot), "vbrief", "PROJECT-DEFINITION.vbrief.json");
  if (!existsSync(path)) return false;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const plan = data.plan;
    if (typeof plan !== "object" || plan === null || Array.isArray(plan)) return false;
    const scope = (plan as Record<string, unknown>).policy;
    if (typeof scope !== "object" || scope === null || Array.isArray(scope)) return false;
    const triageScope = (scope as Record<string, unknown>).triageScope;
    return (
      Array.isArray(triageScope) &&
      triageScope.length > 0 &&
      triageScope.every((r) => typeof r === "object" && r !== null)
    );
  } catch {
    return false;
  }
}

function utcIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function computeSummary(projectRoot: string): SummaryResult {
  const root = resolve(projectRoot);
  const cacheRoot = join(root, CACHE_DIR_NAME);
  const logPath = join(root, CANDIDATES_LOG_REL_PATH);
  const cached = iterCachedIssues(cacheRoot);
  const repos = [...new Set(cached.map(([r]) => r))].sort().slice(0, 8);
  const wipCapResult = resolveWipCap(root);
  const wipCap = wipCapResult.cap;
  const wipCount = countVbriefWip(root);
  const inFlightFilesystem = countFilesystemInFlight(root);
  const triageScopeConfigured = isTriageScopeConfigured(root);

  if (cached.length === 0) {
    return {
      cacheEmpty: true,
      untriaged: 0,
      staleDefer: 0,
      inFlight: inFlightFilesystem,
      wipCount,
      wipCap,
      repos,
      scopeDrift: 0,
      inFlightFilesystem,
      inFlightCacheScoped: 0,
      triageScopeConfigured,
      reconcilable: 0,
    };
  }

  const decisions = latestDecisions(readAuditLog(logPath));
  let untriaged = 0;
  let inFlightCacheScoped = 0;
  let staleDefer = 0;
  const noDecisionKeys: Array<[string, number]> = [];
  for (const [repo, issueNumber] of cached) {
    const key = `${repo}:${issueNumber}`;
    const decision = decisions.get(key);
    if (decision === undefined || decision === "reset" || !TRIAGED_DECISIONS.has(decision)) {
      untriaged += 1;
    }
    if (decision === undefined) noDecisionKeys.push([repo, issueNumber]);
    else if (IN_FLIGHT_DECISIONS.has(decision)) inFlightCacheScoped += 1;
    if (decision !== undefined && STALE_DEFER_DECISIONS.has(decision)) staleDefer += 1;
  }

  let scopeDrift = 0;
  try {
    scopeDrift = computeDrift(root, { cacheRoot }).total;
  } catch {
    scopeDrift = 0;
  }

  let reconcilable = 0;
  try {
    const repoSet = new Set(noDecisionKeys.map(([r]) => r));
    const defaultRepo = repoSet.size === 1 ? ([...repoSet][0] ?? null) : null;
    reconcilable = countReconcilable(root, {
      defaultRepo,
      auditLogPath: logPath,
      restrictTo: noDecisionKeys,
    });
  } catch {
    reconcilable = 0;
  }

  return {
    cacheEmpty: false,
    untriaged,
    staleDefer,
    inFlight: inFlightFilesystem,
    wipCount,
    wipCap,
    repos,
    scopeDrift,
    inFlightFilesystem,
    inFlightCacheScoped,
    triageScopeConfigured,
    reconcilable,
  };
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 3)}...`;
}

export function formatOneLiner(result: SummaryResult, maxChars = MAX_LINE_CHARS): string {
  if (result.cacheEmpty) return truncate(EMPTY_CACHE_LINE, maxChars);
  const parts = [`[triage] ${result.untriaged} untriaged`];
  if (result.staleDefer >= 1) {
    parts.push(`${result.staleDefer} stale-defer (resume condition met)`);
  }
  parts.push(`${result.inFlight} in-flight`);
  let wipField = `WIP ${result.wipCount}/${result.wipCap}`;
  if (result.wipCount >= result.wipCap) wipField = `${wipField} ${WIP_WARN_GLYPH}`;
  parts.push(wipField);
  if (result.scopeDrift > 0) parts.push(`[scope-drift] ${result.scopeDrift}`);
  let candidate = parts.join(" \u00b7 ");
  if (candidate.length <= maxChars) return candidate;
  if (wipField.includes(WIP_WARN_GLYPH)) {
    const rebuilt = [...parts.slice(0, -1), `WIP ${result.wipCount}/${result.wipCap}`];
    candidate = rebuilt.join(" \u00b7 ");
    if (candidate.length <= maxChars) return candidate;
  }
  if (result.staleDefer >= 1) {
    candidate = [
      `[triage] ${result.untriaged} untriaged`,
      `${result.inFlight} in-flight`,
      `WIP ${result.wipCount}/${result.wipCap}`,
    ].join(" \u00b7 ");
    if (candidate.length <= maxChars) return candidate;
  }
  return truncate(candidate, maxChars);
}

function formatScopeDiscrepancyLine(result: SummaryResult): string | null {
  if (result.cacheEmpty) return null;
  const delta = Math.abs(result.inFlightFilesystem - result.inFlightCacheScoped);
  if (delta === 0) return null;
  if (result.triageScopeConfigured) {
    return `[triage:scope] ${delta} in-flight outside plan.policy.triageScope[] (uncounted in queue ranking)`;
  }
  return `[triage:scope] ${delta} in-flight; plan.policy.triageScope[] not configured (uncounted in queue ranking)`;
}

function formatReconcileHintLine(result: SummaryResult): string | null {
  if (result.cacheEmpty || result.reconcilable <= 0) return null;
  return (
    `[triage:reconcile] ${result.reconcilable} accepted on disk but missing from the audit log -- ` +
    "run `task triage:reconcile` to restore"
  );
}

export function formatSummary(result: SummaryResult, maxChars = MAX_LINE_CHARS): string {
  const lines = [formatOneLiner(result, maxChars)];
  const scopeLine = formatScopeDiscrepancyLine(result);
  if (scopeLine) lines.push(scopeLine);
  const reconcileLine = formatReconcileHintLine(result);
  if (reconcileLine) lines.push(reconcileLine);
  return lines.join("\n");
}

export function appendHistory(historyPath: string, result: SummaryResult, line: string): void {
  const record = {
    schema: SUMMARY_HISTORY_SCHEMA,
    emitted_at: utcIso(),
    line,
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
  try {
    mkdirSync(join(historyPath, ".."), { recursive: true });
    appendFileSync(historyPath, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // observability only
  }
}

export function emitOneliner(
  projectRoot: string,
  options: { writeHistory?: boolean; output?: (line: string) => void } = {},
): string {
  const result = computeSummary(projectRoot);
  const line = formatSummary(result);
  const out = options.output ?? ((l: string) => process.stdout.write(`${l}\n`));
  for (const physicalLine of line.split("\n")) {
    out(physicalLine);
  }
  if (options.writeHistory !== false) {
    appendHistory(join(resolve(projectRoot), SUMMARY_HISTORY_REL_PATH), result, line);
  }
  return line;
}
