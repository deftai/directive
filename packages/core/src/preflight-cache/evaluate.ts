/**
 * preflight-cache/evaluate.ts -- Detection-bound cache-freshness gate (#1127).
 *
 * TypeScript port of scripts/preflight_cache.py. Checks whether the triage
 * cache is fresh, missing (bootstrap state), or stale. Subscription-aware:
 * respects plan.policy.triageScope[] when present in PROJECT-DEFINITION.
 *
 * Exit codes (three-state, mirrors preflight_cache.py):
 *   0 -- cache fresh (or bootstrap state with --allow-missing-bootstrap)
 *   1 -- cache stale / blocking condition found
 *   2 -- config error (cache missing and --allow-missing-bootstrap not set)
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// ---------------------------------------------------------------------------
// Public constants (mirror preflight_cache.py)
// ---------------------------------------------------------------------------

export const CACHE_DIR_NAME = ".deft-cache";
export const DEFAULT_SOURCE = "github-issue";
export const CANDIDATES_RELPATH = join("vbrief", ".eval", "candidates.jsonl");
export const DEFAULT_MAX_AGE_HOURS = 24;
export const ENV_MAX_AGE_HOURS = "DEFT_CACHE_MAX_AGE_HOURS";
export const ENV_TRIAGE_REPO = "DEFT_TRIAGE_REPO";
export const REQUIRED_DECISION = "accept";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GateResult {
  readonly code: number;
  readonly message: string;
}

export interface EvaluateOptions {
  source?: string;
  repo?: string | null;
  maxAgeHours?: number | null;
  forIssue?: number | null;
  allowStale?: boolean;
  allowMissingBootstrap?: boolean;
  /** Injectable clock for tests. */
  nowFn?: () => Date;
}

// ---------------------------------------------------------------------------
// Repo discovery helpers
// ---------------------------------------------------------------------------

function inferRepoFromGit(projectRoot: string): string | null {
  try {
    const stdout = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return normaliseRepoUrl(stdout.trim());
  } catch {
    return null;
  }
}

function normaliseRepoUrl(url: string): string | null {
  if (!url) return null;
  const cleaned = url.replace(/\/$/, "").replace(/\.git$/, "");
  if (!cleaned.includes("github.com")) return null;
  const tail =
    cleaned
      .split("github.com")
      .pop()
      ?.replace(/^[:/]+/, "") ?? "";
  const parts = tail.split("/");
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return `${parts[0]}/${parts[1]}`;
  }
  return null;
}

function scanCacheForSingleRepo(cacheRoot: string, source: string): string | null {
  const base = join(cacheRoot, source);
  if (!existsSync(base)) return null;
  const pairs: Array<[string, string]> = [];
  try {
    for (const ownerEntry of readdirSync(base)) {
      const ownerDir = join(base, ownerEntry);
      try {
        for (const repoEntry of readdirSync(ownerDir)) {
          const repoDir = join(ownerDir, repoEntry);
          if (statSync(repoDir).isDirectory()) {
            pairs.push([ownerEntry, repoEntry]);
          }
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    return null;
  }
  if (pairs.length === 1 && pairs[0]) {
    return `${pairs[0][0]}/${pairs[0][1]}`;
  }
  return null;
}

function resolveRepo(
  projectRoot: string,
  cacheRoot: string,
  source: string,
  explicit: string | null | undefined,
): string | null {
  if (explicit) return explicit;
  const envRepo = (process.env[ENV_TRIAGE_REPO] ?? "").trim();
  if (envRepo) return envRepo;
  const git = inferRepoFromGit(projectRoot);
  if (git) return git;
  return scanCacheForSingleRepo(cacheRoot, source);
}

// ---------------------------------------------------------------------------
// Cache scanning helpers
// ---------------------------------------------------------------------------

function iterMetaPaths(cacheRoot: string, source: string, repo: string): string[] {
  if (!repo.includes("/")) return [];
  const [owner, name] = repo.split("/", 2) as [string, string];
  const repoDir = join(cacheRoot, source, owner, name);
  if (!existsSync(repoDir)) return [];
  const results: string[] = [];
  try {
    for (const entry of readdirSync(repoDir)) {
      const entryDir = join(repoDir, entry);
      const meta = join(entryDir, "meta.json");
      if (existsSync(meta)) {
        results.push(meta);
      }
    }
  } catch {
    /* skip */
  }
  return results;
}

function readMeta(metaPath: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(metaPath, "utf8");
    const data = JSON.parse(raw) as unknown;
    return data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function metaFetchedAt(metaPath: string): Date | null {
  const data = readMeta(metaPath);
  if (data === null) return null;
  const stamp = data.fetched_at ?? data.cached_at ?? data.updated_at;
  if (typeof stamp !== "string") return null;
  try {
    return new Date(stamp);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Subscription-aware scope filtering
// ---------------------------------------------------------------------------

interface ScopeRule {
  readonly label?: string;
  readonly labelPrefix?: string;
  readonly repo?: string;
  readonly repoPattern?: string;
}

function loadScopeRules(projectRoot: string): ScopeRule[] | null {
  const defPath = join(projectRoot, "vbrief", "PROJECT-DEFINITION.vbrief.json");
  if (!existsSync(defPath)) return null;
  try {
    const data = JSON.parse(readFileSync(defPath, "utf8")) as unknown;
    if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
    const plan = (data as Record<string, unknown>).plan;
    if (plan === null || typeof plan !== "object" || Array.isArray(plan)) return null;
    const policy = (plan as Record<string, unknown>).policy;
    if (policy === null || typeof policy !== "object" || Array.isArray(policy)) return null;
    const scope = (policy as Record<string, unknown>).triageScope;
    if (!Array.isArray(scope)) return null;
    return scope as ScopeRule[];
  } catch {
    return null;
  }
}

function issueMatchesScope(rules: ScopeRule[], rawIssue: Record<string, unknown>): boolean {
  if (rules.length === 0) return true;
  // A rule matches if any condition in that rule matches the issue.
  for (const rule of rules) {
    if (ruleMatchesIssue(rule, rawIssue)) return true;
  }
  return false;
}

function ruleMatchesIssue(rule: ScopeRule, rawIssue: Record<string, unknown>): boolean {
  const labels = (rawIssue.labels as Array<Record<string, unknown>> | undefined) ?? [];
  const labelNames = labels
    .map((l) => (typeof l === "object" && l !== null ? String(l.name ?? "") : ""))
    .filter(Boolean);

  if (rule.label !== undefined) {
    if (!labelNames.includes(rule.label)) return false;
  }
  if (rule.labelPrefix !== undefined) {
    if (!labelNames.some((l) => l.startsWith(rule.labelPrefix ?? ""))) return false;
  }
  if (rule.repo !== undefined) {
    const issueRepo = String(
      (rawIssue.repository as Record<string, unknown> | undefined)?.full_name ?? "",
    );
    if (issueRepo !== rule.repo) return false;
  }
  if (rule.repoPattern !== undefined) {
    const issueRepo = String(
      (rawIssue.repository as Record<string, unknown> | undefined)?.full_name ?? "",
    );
    try {
      if (!new RegExp(rule.repoPattern).test(issueRepo)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Candidates log helpers
// ---------------------------------------------------------------------------

function candidatesLogState(candidatesPath: string): "absent" | "empty" | "populated" {
  if (!existsSync(candidatesPath)) return "absent";
  try {
    const stat = statSync(candidatesPath);
    if (stat.size === 0) return "empty";
    const text = readFileSync(candidatesPath, "utf8");
    for (const line of text.split("\n")) {
      if (line.trim().length > 0) return "populated";
    }
    return "empty";
  } catch {
    return "absent";
  }
}

interface CandidateEntry {
  readonly issue: number;
  readonly repo: string;
  readonly decision: string;
  readonly ts: string;
}

function parseCandidates(candidatesPath: string): CandidateEntry[] {
  if (!existsSync(candidatesPath)) return [];
  try {
    const text = readFileSync(candidatesPath, "utf8");
    const entries: CandidateEntry[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const data = JSON.parse(trimmed) as unknown;
        if (data !== null && typeof data === "object" && !Array.isArray(data)) {
          const d = data as Record<string, unknown>;
          entries.push({
            issue: Number(d.issue ?? 0),
            repo: String(d.repo ?? ""),
            decision: String(d.decision ?? ""),
            ts: String(d.ts ?? d.timestamp ?? ""),
          });
        }
      } catch {
        /* skip malformed lines */
      }
    }
    return entries;
  } catch {
    return [];
  }
}

function latestDecisionForIssue(
  candidates: CandidateEntry[],
  repo: string,
  issueNumber: number,
): CandidateEntry | null {
  // Take all entries matching this issue (most recent last)
  const matching = candidates.filter((c) => c.issue === issueNumber && c.repo === repo);
  return matching[matching.length - 1] ?? null;
}

// ---------------------------------------------------------------------------
// Main evaluate function
// ---------------------------------------------------------------------------

const REMEDIATION_NO_CACHE = ["  Recovery: run `deft triage:bootstrap` to seed the cache."].join(
  "\n",
);

const REMEDIATION_STALE = ["  Recovery: run `deft cache:fetch-all` to refresh the cache."].join(
  "\n",
);

const REMEDIATION_NO_CANDIDATES = [
  "  Recovery: run `deft triage:bootstrap` to initialise the triage log.",
].join("\n");

/**
 * Evaluate cache freshness for the given project root.
 *
 * Faithful port of scripts/preflight_cache.py::evaluate().
 */
export function evaluate(projectRoot: string, options: EvaluateOptions = {}): GateResult {
  const source = options.source ?? DEFAULT_SOURCE;
  const allowStale = options.allowStale ?? false;
  const allowMissingBootstrap = options.allowMissingBootstrap ?? false;
  const nowFn = options.nowFn ?? (() => new Date());

  const envMaxAge = process.env[ENV_MAX_AGE_HOURS];
  const envMaxAgeParsed = envMaxAge !== undefined ? Number.parseInt(envMaxAge, 10) : null;
  const maxAgeHours =
    options.maxAgeHours ??
    (envMaxAgeParsed !== null && !Number.isNaN(envMaxAgeParsed) ? envMaxAgeParsed : null) ??
    DEFAULT_MAX_AGE_HOURS;

  const cacheRoot = join(projectRoot, CACHE_DIR_NAME);
  const candidatesPath = join(projectRoot, CANDIDATES_RELPATH);

  // Step 1: Resolve repo slug
  const resolvedRepo = resolveRepo(projectRoot, cacheRoot, source, options.repo ?? null);

  // Step 2: Check cache dir exists
  const sourceDirExists = existsSync(join(cacheRoot, source));
  if (!sourceDirExists) {
    if (allowMissingBootstrap) {
      return {
        code: 0,
        message: `✓ deft cache-fresh: no cache found (bootstrap state) -- treating as fresh.`,
      };
    }
    return {
      code: 2,
      message: [
        `❌ deft cache-fresh: .deft-cache/${source}/ not found at ${projectRoot}.`,
        REMEDIATION_NO_CACHE,
      ].join("\n"),
    };
  }

  // Step 3: Check candidates log
  const candState = candidatesLogState(candidatesPath);
  if (candState === "absent") {
    if (allowMissingBootstrap) {
      return {
        code: 0,
        message: `✓ deft cache-fresh: candidates log missing (bootstrap state) -- treating as fresh.`,
      };
    }
    return {
      code: 2,
      message: [
        `❌ deft cache-fresh: ${CANDIDATES_RELPATH} not found at ${projectRoot}.`,
        REMEDIATION_NO_CANDIDATES,
      ].join("\n"),
    };
  }

  // Step 4: Collect meta paths (optionally filtered by scope)
  const scopeRules = loadScopeRules(projectRoot);
  const allMetaPaths = resolvedRepo !== null ? iterMetaPaths(cacheRoot, source, resolvedRepo) : [];

  const scopedMetaPaths =
    scopeRules !== null && scopeRules.length > 0
      ? allMetaPaths.filter((p) => {
          const rawPath = join(p, "..", "raw.json");
          if (!existsSync(rawPath)) return false;
          try {
            const raw = JSON.parse(readFileSync(rawPath, "utf8")) as unknown;
            if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
              return issueMatchesScope(scopeRules, raw as Record<string, unknown>);
            }
          } catch {
            /* skip */
          }
          return false;
        })
      : allMetaPaths;

  // Detect backfill-only (cache has entries but none match scope, audit log populated)
  const backfillOnly =
    scopeRules !== null &&
    scopeRules.length > 0 &&
    allMetaPaths.length > 0 &&
    scopedMetaPaths.length === 0 &&
    candState === "populated";

  // Step 5: Find newest entry
  let maxFetchedAt: Date | null = null;
  let maxMetaPath: string | null = null;

  for (const p of scopedMetaPaths.length > 0 ? scopedMetaPaths : allMetaPaths) {
    const ts = metaFetchedAt(p);
    if (ts !== null && (maxFetchedAt === null || ts > maxFetchedAt)) {
      maxFetchedAt = ts;
      maxMetaPath = p;
    }
  }

  const now = nowFn();
  const ageMs = maxFetchedAt !== null ? now.getTime() - maxFetchedAt.getTime() : Infinity;
  const ageH = ageMs / (1000 * 3600);
  const stale = ageH > maxAgeHours;

  // Step 5b: --allow-stale bypass
  if (stale && allowStale) {
    const warning = [
      `⚠ deft cache-fresh: cache is ${ageH.toFixed(1)}h old (max-age=${maxAgeHours}h) but`,
      `  --allow-stale is set -- proceeding with audit-trail warning.`,
    ].join("\n");
    if (options.forIssue !== undefined && options.forIssue !== null) {
      const forResult = evaluateForIssue(
        resolvedRepo,
        options.forIssue,
        candidatesPath,
        cacheRoot,
        source,
        scopeRules,
        projectRoot,
      );
      if (forResult.code !== 0) return forResult;
    }
    return { code: 0, message: warning };
  }

  if (stale) {
    const display = maxMetaPath !== null ? relative(projectRoot, maxMetaPath) : "?";
    return {
      code: 1,
      message: [
        `❌ deft cache-fresh: cache is ${ageH.toFixed(1)}h old (max-age=${maxAgeHours}h); newest entry ${display}.`,
        REMEDIATION_STALE,
      ].join("\n"),
    };
  }

  // Step 6: --for-issue
  if (options.forIssue !== undefined && options.forIssue !== null) {
    const forResult = evaluateForIssue(
      resolvedRepo,
      options.forIssue,
      candidatesPath,
      cacheRoot,
      source,
      scopeRules,
      projectRoot,
    );
    if (forResult.code !== 0) return forResult;
  }

  // Build OK message
  const auditState = candState;
  let statePhrase: string;
  let inScopeCount: number;

  if (backfillOnly) {
    statePhrase =
      "backfill-only cache (no entries match plan.policy.triageScope[]; audit log populated)";
    inScopeCount = 0;
  } else if (auditState === "empty") {
    statePhrase = "fresh bootstrap, no triage actions yet";
    inScopeCount = scopedMetaPaths.length;
  } else {
    statePhrase = "actively triaging";
    inScopeCount = scopedMetaPaths.length;
  }

  const repoLabel = resolvedRepo ?? "unknown-repo";
  let msg = `✓ deft cache-fresh: ${repoLabel} -- ${inScopeCount} entry/ies in scope; newest fetched ${ageH.toFixed(1)}h ago (max-age=${maxAgeHours}h); ${statePhrase}.`;
  if (options.forIssue !== undefined && options.forIssue !== null) {
    msg += ` Issue #${options.forIssue} latest decision = accept; in subscription scope.`;
  }
  return { code: 0, message: msg };
}

function evaluateForIssue(
  repo: string | null,
  issueNumber: number,
  candidatesPath: string,
  cacheRoot: string,
  source: string,
  scopeRules: ScopeRule[] | null,
  _projectRoot: string,
): GateResult {
  if (repo === null) {
    return {
      code: 1,
      message: `❌ deft cache-fresh: cannot verify issue #${issueNumber} -- repo not resolved.`,
    };
  }

  // Scope check
  if (scopeRules !== null && scopeRules.length > 0) {
    const [owner, name] = repo.split("/", 2) as [string, string];
    const rawPath = join(cacheRoot, source, owner, name, String(issueNumber), "raw.json");
    if (existsSync(rawPath)) {
      try {
        const raw = JSON.parse(readFileSync(rawPath, "utf8")) as unknown;
        if (
          raw !== null &&
          typeof raw === "object" &&
          !Array.isArray(raw) &&
          !issueMatchesScope(scopeRules, raw as Record<string, unknown>)
        ) {
          return {
            code: 1,
            message: [
              `❌ deft cache-fresh: issue #${issueNumber} is OUTSIDE the active plan.policy.triageScope[] subscription.`,
              `  Recovery: widen the subscription (see \`deft triage:scope --list\`) or open it via`,
              `  \`deft triage:accept -- --repo ${repo} --issue ${issueNumber}\` after confirming the scope rule covers it.`,
            ].join("\n"),
          };
        }
      } catch {
        /* proceed */
      }
    }
  }

  // Latest-decision check
  const candidates = parseCandidates(candidatesPath);
  const latest = latestDecisionForIssue(candidates, repo, issueNumber);

  if (latest === null) {
    return {
      code: 1,
      message: [
        `❌ deft cache-fresh: issue #${issueNumber} has no triage decision in ${CANDIDATES_RELPATH}.`,
        `  Recovery: \`deft triage:accept -- --repo ${repo} --issue ${issueNumber}\` before dispatching an implementation agent.`,
      ].join("\n"),
    };
  }

  if (latest.decision !== REQUIRED_DECISION) {
    return {
      code: 1,
      message: [
        `❌ deft cache-fresh: issue #${issueNumber} latest decision is '${latest.decision}', not '${REQUIRED_DECISION}' -- dispatch refused.`,
        `  Recovery: re-evaluate via \`deft triage:status -- --repo ${repo} --issue ${issueNumber}\` and run \`deft triage:accept\` once the item is ready, or pick a different issue.`,
      ].join("\n"),
    };
  }

  return { code: 0, message: `✓ issue #${issueNumber} cleared (decision=accept).` };
}
