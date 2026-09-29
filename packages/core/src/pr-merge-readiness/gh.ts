import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultWhich } from "../scm/binary.js";
import { classifyScmArgv, resolveBinaryForArgv } from "../scm/call-shape.js";
import { ghxSpawnFallbackBinary } from "../scm/spawn-status.js";
import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";
import { GH_TIMEOUT_S, GREPTILE_LOGIN } from "./constants.js";
import type { RunGhFn, RunGhResult } from "./types.js";

export interface CheckRunRecord {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string;
  /** check-run `output.summary` text, when present (used by the SLizard verdict gate, #2189). */
  readonly summary?: string;
  /** ISO created_at — capacity-stall budget clock (#2672). */
  readonly created_at?: string | null;
  /** ISO started_at — null while still queued with no runner (#2672). */
  readonly started_at?: string | null;
  /**
   * GitHub App id that produced the check run (`app.id`), when present.
   * Used to match app-bound required contexts from rulesets / branch protection (#3234).
   */
  readonly appId?: number | null;
}

/**
 * A required status-check context name, optionally bound to a GitHub App id
 * (branch-protection `app_id` / ruleset `integration_id`) (#3234).
 */
export interface RequiredStatusContext {
  readonly name: string;
  readonly appId?: number | null;
}

/** Display / inventory key for a required context (includes app binding when set). */
export function requiredContextLabel(ctx: RequiredStatusContext): string {
  if (ctx.appId != null) {
    return `${ctx.name} (app:${ctx.appId})`;
  }
  return ctx.name;
}

/** Normalize injected string names or full specs into RequiredStatusContext (#3234). */
export function normalizeRequiredContexts(
  input: readonly (string | RequiredStatusContext)[] | undefined,
): RequiredStatusContext[] {
  if (input === undefined) {
    return [];
  }
  const out: RequiredStatusContext[] = [];
  for (const item of input) {
    if (typeof item === "string") {
      if (item.length > 0) {
        out.push({ name: item });
      }
      continue;
    }
    if (
      item !== null &&
      typeof item === "object" &&
      typeof item.name === "string" &&
      item.name.length > 0
    ) {
      const appId =
        typeof item.appId === "number" && Number.isFinite(item.appId) ? item.appId : null;
      out.push(appId === null ? { name: item.name } : { name: item.name, appId });
    }
  }
  return out;
}

/** True when an observed check-run satisfies a required context (name + optional app id). */
export function checkRunMatchesRequiredContext(
  run: CheckRunRecord,
  ctx: RequiredStatusContext,
): boolean {
  if (run.name !== ctx.name) {
    return false;
  }
  if (ctx.appId == null) {
    return true;
  }
  return run.appId === ctx.appId;
}

/** UTF-8-safe gh capture via execFile (no shell) — mirrors _safe_subprocess.run_text (#1366). */
export function defaultRunGh(cmd: readonly string[]): RunGhResult {
  if (cmd.length === 0 || cmd[0] !== "gh") {
    return { returncode: -1, stdout: "", stderr: "expected gh as first argv element" };
  }
  const args = cmd.slice(1);
  const binary = resolveBinaryForArgv(args[0] ?? "", args.slice(1));
  const execOpts = {
    encoding: "utf8" as const,
    timeout: GH_TIMEOUT_S * 1000,
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
    maxBuffer: SUBPROCESS_MAX_BUFFER,
  };
  const runOnce = (bin: string) => execFileSync(bin, args, execOpts);
  try {
    const stdout = runOnce(binary);
    return { returncode: 0, stdout: typeof stdout === "string" ? stdout : "", stderr: "" };
  } catch (caught: unknown) {
    let err: unknown = caught;
    const first = err as {
      status?: number;
      stdout?: string;
      stderr?: string;
      code?: string;
      message?: string;
    };
    const retry = ghxSpawnFallbackBinary(
      classifyScmArgv(args[0] ?? "", args.slice(1)),
      binary,
      defaultWhich,
      {
        status: typeof first.status === "number" ? first.status : null,
        error:
          first.code === "ENOENT" || first.code === "ETIMEDOUT" || typeof first.status !== "number"
            ? { code: first.code, message: first.message }
            : undefined,
        stdout: typeof first.stdout === "string" ? first.stdout : "",
        stderr: typeof first.stderr === "string" ? first.stderr : "",
      },
    );
    if (retry !== null) {
      try {
        const stdout = runOnce(retry);
        return { returncode: 0, stdout: typeof stdout === "string" ? stdout : "", stderr: "" };
      } catch (retryErr: unknown) {
        err = retryErr;
      }
    }
    const e = err as {
      status?: number;
      stdout?: string;
      stderr?: string;
      code?: string;
      message?: string;
    };
    if (e.code === "ENOENT") {
      return { returncode: -1, stdout: "", stderr: "gh CLI not found. Install GitHub CLI." };
    }
    if (e.code === "ETIMEDOUT") {
      return { returncode: -1, stdout: "", stderr: `gh CLI timed out: ${cmd.join(" ")}` };
    }
    return {
      returncode: typeof e.status === "number" ? e.status : -1,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : String(e.message ?? ""),
    };
  }
}

export function fetchPrHeadSha(
  prNumber: number,
  repo: string | null,
  runGh: RunGhFn,
): string | null {
  const cmd = ["gh", "pr", "view", String(prNumber), "--json", "headRefOid", "--jq", ".headRefOid"];
  if (repo) {
    cmd.push("--repo", repo);
  }
  const { returncode, stdout, stderr } = runGh(cmd);
  if (returncode !== 0) {
    process.stderr.write(
      `Error: gh failed fetching PR #${prNumber} headRefOid: ${stderr.trim()}\n`,
    );
    return null;
  }
  const sha = stdout.trim();
  return sha.length > 0 ? sha : null;
}

export function fetchGreptileCommentBody(
  prNumber: number,
  repo: string | null,
  runGh: RunGhFn,
): string | null {
  let resolvedRepo = repo;
  if (!resolvedRepo) {
    const rc = runGh(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
    if (rc.returncode !== 0) {
      process.stderr.write(`Error: could not resolve --repo from cwd: ${rc.stderr.trim()}\n`);
      return null;
    }
    resolvedRepo = rc.stdout.trim();
    if (!resolvedRepo) {
      process.stderr.write("Error: empty repo from gh repo view (specify --repo OWNER/REPO).\n");
      return null;
    }
  }

  const cmd = [
    "gh",
    "api",
    `repos/${resolvedRepo}/issues/${prNumber}/comments`,
    "--paginate",
    "--jq",
    // Prefer most recently *updated* Greptile summary. Greptile edits the
    // primary rolling summary in place; a later-created duplicate can stay
    // SHA-stale and must not win over the refreshed primary (#1056 / #2658).
    `[.[] | select(.user.login == "${GREPTILE_LOGIN}")] | sort_by(.updated_at) | last | .body // ""`,
  ];
  const { returncode, stdout, stderr } = runGh(cmd);
  if (returncode !== 0) {
    process.stderr.write(
      `Error: gh failed fetching comments for PR #${prNumber}: ${stderr.trim()}\n`,
    );
    return null;
  }
  return stdout;
}

export function resolveRepo(
  repo: string | null,
  runGh: RunGhFn,
): { repo: string | null; error: string } {
  if (repo) {
    return { repo, error: "" };
  }
  const rc = runGh(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  if (rc.returncode !== 0) {
    return { repo: null, error: `could not resolve --repo from cwd: ${rc.stderr.trim()}` };
  }
  const resolved = rc.stdout.trim();
  if (!resolved) {
    return { repo: null, error: "empty repo from gh repo view (specify --repo OWNER/REPO)" };
  }
  return { repo: resolved, error: "" };
}

export function fetchGreptileBodyRest(
  prNumber: number,
  repo: string,
  runGh: RunGhFn,
): { body: string | null; error: string } {
  const rc = runGh(["gh", "api", `repos/${repo}/issues/${prNumber}/comments`, "--paginate"]);
  if (rc.returncode !== 0) {
    return {
      body: null,
      error: `gh api /issues/${prNumber}/comments failed: ${rc.stderr.trim()}`,
    };
  }
  if (!rc.stdout.trim()) {
    return { body: "", error: "" };
  }

  return parsePaginatedComments(rc.stdout.trim());
}

function parsePaginatedComments(text: string): { body: string | null; error: string } {
  const comments: unknown[] = [];
  const decoder = new PaginatedJsonDecoder();
  let idx = 0;
  while (idx < text.length) {
    const result = decoder.rawDecode(text, idx);
    if (result === null) {
      if (idx < text.length) {
        return { body: null, error: "could not parse REST comments JSON: invalid JSON at offset" };
      }
      break;
    }
    const [obj, end] = result;
    if (Array.isArray(obj)) {
      comments.push(...obj);
    } else if (obj !== null && typeof obj === "object") {
      comments.push(obj);
    }
    idx = end;
  }

  let bestBody = "";
  let bestUpdatedAt = "";
  for (const c of comments) {
    if (
      c !== null &&
      typeof c === "object" &&
      !Array.isArray(c) &&
      "user" in c &&
      c.user !== null &&
      typeof c.user === "object" &&
      !Array.isArray(c.user) &&
      "login" in c.user &&
      c.user.login === GREPTILE_LOGIN &&
      "body" in c &&
      typeof c.body === "string"
    ) {
      const updatedAt = "updated_at" in c && typeof c.updated_at === "string" ? c.updated_at : "";
      if (updatedAt >= bestUpdatedAt) {
        bestUpdatedAt = updatedAt;
        bestBody = c.body;
      }
    }
  }
  if (bestBody.length === 0 && bestUpdatedAt.length === 0) {
    return { body: "", error: "" };
  }
  return { body: bestBody, error: "" };
}

/** Mirrors Python json.JSONDecoder.raw_decode for concatenated paginate arrays. */
class PaginatedJsonDecoder {
  rawDecode(text: string, idx: number): [unknown, number] | null {
    let pos = idx;
    while (pos < text.length && /\s/.test(text.charAt(pos))) {
      pos += 1;
    }
    if (pos >= text.length) {
      return null;
    }
    try {
      let end = pos;
      let depth = 0;
      let inString = false;
      let isEscaped = false;
      const startChar = text.charAt(pos);
      if (startChar !== "[" && startChar !== "{") {
        return null;
      }
      for (; end < text.length; end += 1) {
        const ch = text.charAt(end);
        if (inString) {
          if (isEscaped) {
            isEscaped = false;
          } else if (ch === "\\") {
            isEscaped = true;
          } else if (ch === '"') {
            inString = false;
          }
          continue;
        }
        if (ch === '"') {
          inString = true;
          continue;
        }
        if (ch === "[" || ch === "{") {
          depth += 1;
        } else if (ch === "]" || ch === "}") {
          depth -= 1;
          if (depth === 0) {
            end += 1;
            break;
          }
        }
      }
      const slice = text.slice(pos, end);
      const obj = JSON.parse(slice) as unknown;
      return [obj, end];
    } catch {
      return null;
    }
  }
}

export function fetchPrHeadShaRest(
  prNumber: number,
  repo: string,
  runGh: RunGhFn,
): { sha: string | null; error: string } {
  const rc = runGh(["gh", "api", `repos/${repo}/pulls/${prNumber}`]);
  if (rc.returncode !== 0) {
    return { sha: null, error: `gh api /pulls/${prNumber} failed: ${rc.stderr.trim()}` };
  }
  if (!rc.stdout.trim()) {
    return { sha: null, error: "empty body from gh api /pulls/<N>" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rc.stdout) as unknown;
  } catch (exc: unknown) {
    const message = exc instanceof Error ? exc.message : String(exc);
    return { sha: null, error: `could not parse PR JSON: ${message}` };
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { sha: null, error: "unexpected PR JSON shape (not a dict)" };
  }
  const head = (payload as Record<string, unknown>).head;
  if (head !== null && typeof head === "object" && !Array.isArray(head)) {
    const sha = (head as Record<string, unknown>).sha;
    if (typeof sha === "string" && sha.length > 0) {
      return { sha, error: "" };
    }
  }
  return { sha: null, error: "PR JSON missing head.sha" };
}

/** Pull the `output.summary` string off a raw check-run payload, if present (#2189). */
function extractCheckRunSummary(run: Record<string, unknown>): string | null {
  const output = run.output;
  if (output === null || typeof output !== "object" || Array.isArray(output)) {
    return null;
  }
  const summary = (output as Record<string, unknown>).summary;
  return typeof summary === "string" && summary.length > 0 ? summary : null;
}

export function fetchCheckRunsRest(
  sha: string,
  repo: string,
  runGh: RunGhFn,
): { summary: Record<string, unknown> | null; checkRuns: CheckRunRecord[]; error: string } {
  const rc = runGh(["gh", "api", `repos/${repo}/commits/${sha}/check-runs`]);
  if (rc.returncode !== 0) {
    return {
      summary: null,
      checkRuns: [],
      error: `gh api /commits/${"<"}sha>/check-runs failed: ${rc.stderr.trim()}`,
    };
  }
  if (!rc.stdout.trim()) {
    return {
      summary: null,
      checkRuns: [],
      error: "empty body from gh api /commits/<sha>/check-runs",
    };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rc.stdout) as unknown;
  } catch (exc: unknown) {
    const message = exc instanceof Error ? exc.message : String(exc);
    return { summary: null, checkRuns: [], error: `could not parse check-runs JSON: ${message}` };
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { summary: null, checkRuns: [], error: "unexpected check-runs JSON shape (not a dict)" };
  }
  const runs = (payload as Record<string, unknown>).check_runs;
  if (!Array.isArray(runs)) {
    return { summary: null, checkRuns: [], error: "check-runs JSON missing check_runs list" };
  }
  const checkRuns: CheckRunRecord[] = [];
  const summary: Record<string, unknown> = {
    total: runs.length,
    by_status: {} as Record<string, number>,
    by_conclusion: {} as Record<string, number>,
    greptile_review: null,
    slizard_review: null,
  };
  const byStatus = summary.by_status as Record<string, number>;
  const byConclusion = summary.by_conclusion as Record<string, number>;
  for (const run of runs) {
    if (run === null || typeof run !== "object" || Array.isArray(run)) {
      continue;
    }
    const r = run as Record<string, unknown>;
    const status = typeof r.status === "string" ? r.status : "unknown";
    const conclusion = typeof r.conclusion === "string" ? r.conclusion : "none";
    const name = typeof r.name === "string" && r.name.length > 0 ? r.name : "<unnamed>";
    const runSummary = extractCheckRunSummary(r);
    const createdAt = typeof r.created_at === "string" ? r.created_at : null;
    const startedAt = typeof r.started_at === "string" ? r.started_at : null;
    let appId: number | null = null;
    const appBlock = r.app;
    if (appBlock !== null && typeof appBlock === "object" && !Array.isArray(appBlock)) {
      const id = (appBlock as Record<string, unknown>).id;
      if (typeof id === "number" && Number.isFinite(id)) {
        appId = id;
      }
    }
    const record: CheckRunRecord = {
      name,
      status,
      conclusion,
      created_at: createdAt,
      started_at: startedAt,
      appId,
      ...(runSummary === null ? {} : { summary: runSummary }),
    };
    checkRuns.push(record);
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    byConclusion[conclusion] = (byConclusion[conclusion] ?? 0) + 1;
    if (r.name === "Greptile Review") {
      summary.greptile_review = { status, conclusion };
    }
    if (name.toLowerCase().includes("slizard")) {
      summary.slizard_review = { status, conclusion };
    }
  }
  return { summary, checkRuns, error: "" };
}

/** PR base branch ref (rulesets / branch protection apply to the merge target) (#3234). */
export function fetchPrBaseRef(
  prNumber: number,
  repo: string,
  runGh: RunGhFn,
): { baseRef: string | null; error: string } {
  const rc = runGh(["gh", "api", `repos/${repo}/pulls/${prNumber}`]);
  if (rc.returncode !== 0) {
    return { baseRef: null, error: `gh api /pulls/${prNumber} failed: ${rc.stderr.trim()}` };
  }
  if (!rc.stdout.trim()) {
    return { baseRef: null, error: "empty body from gh api /pulls/<N>" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rc.stdout) as unknown;
  } catch (exc: unknown) {
    const message = exc instanceof Error ? exc.message : String(exc);
    return { baseRef: null, error: `could not parse PR JSON: ${message}` };
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { baseRef: null, error: "unexpected PR JSON shape (not a dict)" };
  }
  const base = (payload as Record<string, unknown>).base;
  if (base !== null && typeof base === "object" && !Array.isArray(base)) {
    const ref = (base as Record<string, unknown>).ref;
    if (typeof ref === "string" && ref.length > 0) {
      return { baseRef: ref, error: "" };
    }
  }
  return { baseRef: null, error: "PR JSON missing base.ref" };
}

function parseOptionalAppId(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  return null;
}

/** Extract required contexts from `GET .../rules/branches/{branch}` payload (#3234). */
export function contextsFromBranchRules(payload: unknown): RequiredStatusContext[] {
  if (!Array.isArray(payload)) {
    return [];
  }
  const out: RequiredStatusContext[] = [];
  for (const rule of payload) {
    if (rule === null || typeof rule !== "object" || Array.isArray(rule)) {
      continue;
    }
    const r = rule as Record<string, unknown>;
    if (r.type !== "required_status_checks") {
      continue;
    }
    const params = r.parameters;
    if (params === null || typeof params !== "object" || Array.isArray(params)) {
      continue;
    }
    const checks = (params as Record<string, unknown>).required_status_checks;
    if (!Array.isArray(checks)) {
      continue;
    }
    for (const check of checks) {
      if (check === null || typeof check !== "object" || Array.isArray(check)) {
        continue;
      }
      const c = check as Record<string, unknown>;
      const context = c.context;
      if (typeof context !== "string" || context.length === 0) {
        continue;
      }
      // Rulesets use integration_id; treat as GitHub App id for check-run matching.
      const appId = parseOptionalAppId(c.integration_id);
      out.push(appId === null ? { name: context } : { name: context, appId });
    }
  }
  return out;
}

/** Extract required contexts from classic branch-protection payload (#3234). */
export function contextsFromBranchProtection(payload: unknown): RequiredStatusContext[] {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }
  const rsc = (payload as Record<string, unknown>).required_status_checks;
  if (rsc === null || typeof rsc !== "object" || Array.isArray(rsc)) {
    return [];
  }
  const block = rsc as Record<string, unknown>;
  const out: RequiredStatusContext[] = [];
  const contexts = block.contexts;
  if (Array.isArray(contexts)) {
    for (const c of contexts) {
      if (typeof c === "string" && c.length > 0) {
        out.push({ name: c });
      }
    }
  }
  const checks = block.checks;
  if (Array.isArray(checks)) {
    for (const check of checks) {
      if (check === null || typeof check !== "object" || Array.isArray(check)) {
        continue;
      }
      const c = check as Record<string, unknown>;
      const context = c.context;
      if (typeof context !== "string" || context.length === 0) {
        continue;
      }
      const appId = parseOptionalAppId(c.app_id);
      out.push(appId === null ? { name: context } : { name: context, appId });
    }
  }
  return out;
}

function contextDedupeKey(ctx: RequiredStatusContext): string {
  return ctx.appId == null ? ctx.name : `${ctx.name}\0${ctx.appId}`;
}

export interface RequiredStatusContextsResult {
  readonly contexts: readonly RequiredStatusContext[];
  /** Which REST surfaces contributed contexts (`rulesets` / `branch_protection`). */
  readonly sources: readonly string[];
  readonly error: string;
  /**
   * True when inventory could not be trusted (parse failure / non-404 REST error
   * with no successful source). Callers MUST fail closed (#3234 Greptile P1).
   */
  readonly resolutionFailed: boolean;
}

/**
 * Resolve required status-check contexts for a branch from rulesets and/or
 * classic branch protection (REST only) (#3234).
 *
 * Absent or 404 sources are soft-skipped (empty contribution). Parse failures
 * and non-404 REST errors with no successful source set `resolutionFailed`.
 * Callers compare returned contexts against exact-HEAD check runs (name +
 * optional app id) and fail closed on absent required contexts.
 */
export function fetchRequiredStatusContexts(
  repo: string,
  branch: string,
  runGh: RunGhFn,
): RequiredStatusContextsResult {
  const found = new Map<string, RequiredStatusContext>();
  const sources: string[] = [];
  const notes: string[] = [];
  let hardFailure = false;
  const encoded = encodeURIComponent(branch);

  const rulesRc = runGh(["gh", "api", `repos/${repo}/rules/branches/${encoded}`]);
  if (rulesRc.returncode === 0) {
    if (!rulesRc.stdout.trim()) {
      // Exit-zero empty body is not a trusted empty inventory (#3234 conf residual).
      notes.push("rules/branches: empty body");
      hardFailure = true;
    } else {
      try {
        const payload = JSON.parse(rulesRc.stdout) as unknown;
        const fromRules = contextsFromBranchRules(payload);
        // Successful parse (including `[]`) is trusted; only non-empty contributes.
        if (fromRules.length > 0) {
          for (const c of fromRules) {
            found.set(contextDedupeKey(c), c);
          }
          sources.push("rulesets");
        } else {
          sources.push("rulesets");
        }
      } catch (exc: unknown) {
        const message = exc instanceof Error ? exc.message : String(exc);
        notes.push(`rules/branches parse: ${message}`);
        hardFailure = true;
      }
    }
  } else {
    // Soft-skip only when the error text clearly indicates no rulesets.
    // Nonzero with empty stderr (or other errors) is fail-closed (#3234).
    const err = rulesRc.stderr.trim();
    if (/404|Not Found/i.test(err)) {
      // no rulesets — soft empty contribution
    } else {
      notes.push(`rules/branches: ${err || `exit ${rulesRc.returncode}`}`);
      hardFailure = true;
    }
  }

  const protRc = runGh(["gh", "api", `repos/${repo}/branches/${encoded}/protection`]);
  if (protRc.returncode === 0) {
    if (!protRc.stdout.trim()) {
      notes.push("branches/protection: empty body");
      hardFailure = true;
    } else {
      try {
        const payload = JSON.parse(protRc.stdout) as unknown;
        const fromProt = contextsFromBranchProtection(payload);
        if (fromProt.length > 0) {
          for (const c of fromProt) {
            found.set(contextDedupeKey(c), c);
          }
          sources.push("branch_protection");
        } else {
          // Successful protection payload with no required checks still counts
          // as a trusted source (inventory empty intentionally).
          sources.push("branch_protection");
        }
      } catch (exc: unknown) {
        const message = exc instanceof Error ? exc.message : String(exc);
        notes.push(`branches/protection parse: ${message}`);
        hardFailure = true;
      }
    }
  } else {
    const err = protRc.stderr.trim();
    if (/404|Not Found|Branch not protected/i.test(err)) {
      // no classic protection — soft empty contribution
    } else {
      notes.push(`branches/protection: ${err || `exit ${protRc.returncode}`}`);
      hardFailure = true;
    }
  }

  const contexts = [...found.values()].sort((a, b) =>
    requiredContextLabel(a).localeCompare(requiredContextLabel(b)),
  );
  // Fail closed on any hard error (parse / non-404), even when another source
  // contributed contexts. Partial inventory can omit unique required checks
  // from the failed source (#3234 Greptile conf residual).
  const resolutionFailed = hardFailure;

  return {
    contexts,
    sources,
    error: notes.join("; "),
    resolutionFailed,
  };
}

/** Detection outcome for forge required-status-check inventory (#1517). */
export type MergeGateEnforcementDetection = "protected" | "absent" | "unknown";

/**
 * Classify #3234 inventory into protected / absent / unknown (#1517).
 * Non-empty contexts => protected. resolutionFailed => unknown (fail-closed).
 * Trusted empty inventory => absent. Do not invent a second classic-404 detector.
 */
export function classifyMergeGateEnforcement(
  inventory: RequiredStatusContextsResult,
): MergeGateEnforcementDetection {
  if (inventory.resolutionFailed) {
    return "unknown";
  }
  if (inventory.contexts.length > 0) {
    return "protected";
  }
  return "absent";
}

/** Durable decision outcomes for merge-gate enforcement readiness (#1517). */
export type MergeGateEnforcementDecision =
  | "configured"
  | "explicit-opt-out"
  | "cannot-configure"
  | "deferred-not-applicable";

export const MERGE_GATE_ENFORCEMENT_SCHEMA = "deft.merge-gate-enforcement.v1" as const;
export const MERGE_GATE_ENFORCEMENT_DIR = ".deft/merge-gate-enforcement";

export interface MergeGateEnforcementRecord {
  readonly schema: typeof MERGE_GATE_ENFORCEMENT_SCHEMA;
  readonly repo: string;
  readonly branch: string;
  readonly decision: MergeGateEnforcementDecision;
  readonly recordedAt: string;
  readonly detection: MergeGateEnforcementDetection | null;
  readonly reason: string;
  readonly contexts?: readonly RequiredStatusContext[];
}

export interface MergeGateEnforcementRecordResult {
  readonly ok: boolean;
  readonly record: MergeGateEnforcementRecord | null;
  readonly error: string;
}

function sanitizeMergeGateScopePart(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "_";
}

/** Repo/branch-scoped path under projectRoot for the durable readiness record (#1517). */
export function mergeGateEnforcementRecordPath(
  projectRoot: string,
  repo: string,
  branch: string,
): string {
  const file = `${sanitizeMergeGateScopePart(repo)}--${sanitizeMergeGateScopePart(branch)}.json`;
  return join(projectRoot, MERGE_GATE_ENFORCEMENT_DIR, file);
}

function isMergeGateDecision(value: unknown): value is MergeGateEnforcementDecision {
  return (
    value === "configured" ||
    value === "explicit-opt-out" ||
    value === "cannot-configure" ||
    value === "deferred-not-applicable"
  );
}

function isMergeGateDetection(value: unknown): value is MergeGateEnforcementDetection {
  return value === "protected" || value === "absent" || value === "unknown";
}

/** Read a durable merge-gate enforcement record (repo/branch scoped) (#1517). */
export function readMergeGateEnforcementRecord(
  projectRoot: string,
  repo: string,
  branch: string,
): MergeGateEnforcementRecordResult {
  const path = mergeGateEnforcementRecordPath(projectRoot, repo, branch);
  if (!existsSync(path)) {
    return { ok: true, record: null, error: "" };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, record: null, error: "merge-gate enforcement record is not an object" };
    }
    const o = raw as Record<string, unknown>;
    if (o.schema !== MERGE_GATE_ENFORCEMENT_SCHEMA) {
      return { ok: false, record: null, error: "unsupported merge-gate enforcement schema" };
    }
    if (typeof o.repo !== "string" || o.repo.length === 0) {
      return { ok: false, record: null, error: "merge-gate enforcement record missing repo" };
    }
    if (typeof o.branch !== "string" || o.branch.length === 0) {
      return { ok: false, record: null, error: "merge-gate enforcement record missing branch" };
    }
    if (!isMergeGateDecision(o.decision)) {
      return { ok: false, record: null, error: "merge-gate enforcement record has invalid decision" };
    }
    if (typeof o.recordedAt !== "string" || o.recordedAt.length === 0) {
      return { ok: false, record: null, error: "merge-gate enforcement record missing recordedAt" };
    }
    if (typeof o.reason !== "string") {
      return { ok: false, record: null, error: "merge-gate enforcement record missing reason" };
    }
    const detection =
      o.detection === null || o.detection === undefined
        ? null
        : isMergeGateDetection(o.detection)
          ? o.detection
          : null;
    if (o.detection !== null && o.detection !== undefined && detection === null) {
      return {
        ok: false,
        record: null,
        error: "merge-gate enforcement record has invalid detection",
      };
    }
    const contexts = Array.isArray(o.contexts)
      ? normalizeRequiredContexts(o.contexts as readonly (string | RequiredStatusContext)[])
      : undefined;
    const record: MergeGateEnforcementRecord = {
      schema: MERGE_GATE_ENFORCEMENT_SCHEMA,
      repo: o.repo,
      branch: o.branch,
      decision: o.decision,
      recordedAt: o.recordedAt,
      detection,
      reason: o.reason,
      ...(contexts !== undefined ? { contexts } : {}),
    };
    return { ok: true, record, error: "" };
  } catch (exc: unknown) {
    const message = exc instanceof Error ? exc.message : String(exc);
    return { ok: false, record: null, error: `merge-gate enforcement record parse: ${message}` };
  }
}

export interface WriteMergeGateEnforcementInput {
  readonly projectRoot: string;
  readonly repo: string;
  readonly branch: string;
  readonly decision: MergeGateEnforcementDecision;
  readonly reason: string;
  readonly detection?: MergeGateEnforcementDetection | null;
  readonly contexts?: readonly RequiredStatusContext[];
  readonly recordedAt?: string;
}

/**
 * Persist a durable merge-gate enforcement decision (#1517).
 * cannot-configure is allowed and stays re-checkable — never coerce a failed
 * configure into explicit-opt-out.
 */
export function writeMergeGateEnforcementRecord(
  input: WriteMergeGateEnforcementInput,
): MergeGateEnforcementRecordResult {
  if (!input.repo.trim() || !input.branch.trim()) {
    return {
      ok: false,
      record: null,
      error: "repo and branch are required for merge-gate enforcement record",
    };
  }
  const record: MergeGateEnforcementRecord = {
    schema: MERGE_GATE_ENFORCEMENT_SCHEMA,
    repo: input.repo.trim(),
    branch: input.branch.trim(),
    decision: input.decision,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    detection: input.detection ?? null,
    reason: input.reason,
    ...(input.contexts !== undefined
      ? { contexts: normalizeRequiredContexts(input.contexts) }
      : {}),
  };
  const path = mergeGateEnforcementRecordPath(input.projectRoot, record.repo, record.branch);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return { ok: true, record, error: "" };
  } catch (exc: unknown) {
    const message = exc instanceof Error ? exc.message : String(exc);
    return { ok: false, record: null, error: `merge-gate enforcement record write: ${message}` };
  }
}

export interface MergeGateConfigureProposal {
  readonly contexts: readonly RequiredStatusContext[];
  /** Candidates only — never auto-promoted into required policy (#1517). */
  readonly candidateContexts?: readonly RequiredStatusContext[];
  readonly pinAppIds: boolean;
}

export interface MergeGateConfigurePayloadResult {
  readonly ok: boolean;
  readonly payload: Record<string, unknown> | null;
  readonly error: string;
}

/**
 * Build a check-only classic protection body for required contexts (#1517).
 * Refuses empty context sets. Does not encode GitHub review-count as the
 * human-merge gate. Preserves existing required_pull_request_reviews when
 * cloning unrelated fields from existingProtection.
 */
export function buildMergeGateConfigurePayload(
  proposal: MergeGateConfigureProposal,
  existingProtection: Record<string, unknown> | null = null,
): MergeGateConfigurePayloadResult {
  const selected = normalizeRequiredContexts(proposal.contexts);
  if (selected.length === 0) {
    return {
      ok: false,
      payload: null,
      error:
        "Refuse empty required-context PUT for merge-gate enforcement (#1517). " +
        "Select operator-confirmed contexts first; discovery candidates are not policy.",
    };
  }
  const checks = selected.map((c) => {
    if (proposal.pinAppIds && c.appId != null) {
      return { context: c.name, app_id: c.appId };
    }
    return { context: c.name };
  });
  const required_status_checks = {
    strict: true,
    contexts: selected.map((c) => c.name),
    checks,
  };
  const base: Record<string, unknown> =
    existingProtection !== null ? { ...existingProtection } : {};
  delete base.url;
  delete base.html_url;
  delete base.contexts_url;
  base.required_status_checks = required_status_checks;
  if (base.enforce_admins === undefined) {
    base.enforce_admins = false;
  }
  if (base.required_linear_history === undefined) {
    base.required_linear_history = false;
  }
  if (base.allow_force_pushes === undefined) {
    base.allow_force_pushes = false;
  }
  if (base.allow_deletions === undefined) {
    base.allow_deletions = false;
  }
  return { ok: true, payload: base, error: "" };
}

export interface ApplyMergeGateConfigureInput {
  readonly repo: string;
  readonly branch: string;
  readonly proposal: MergeGateConfigureProposal;
  readonly runGh: RunGhFn;
  /** When true (default), GET existing protection first and preserve unrelated fields. */
  readonly preserveExisting?: boolean;
}

export interface ApplyMergeGateConfigureResult {
  readonly ok: boolean;
  /** configured on success; cannot-configure on admin/plan/write failure (not opt-out). */
  readonly outcome: "configured" | "cannot-configure" | "refused";
  readonly error: string;
  readonly reRead: RequiredStatusContextsResult | null;
}

/**
 * Optional configure helper — separate from the strategy-start decision (#1517).
 * Never auto-promotes candidateContexts. Failed writes return cannot-configure.
 */
export function applyMergeGateConfigure(
  input: ApplyMergeGateConfigureInput,
): ApplyMergeGateConfigureResult {
  if (
    input.proposal.candidateContexts !== undefined &&
    input.proposal.contexts.length === 0 &&
    input.proposal.candidateContexts.length > 0
  ) {
    return {
      ok: false,
      outcome: "refused",
      error:
        "Observed/discovered check names are candidates only (#1517). " +
        "Pass operator-confirmed contexts; do not auto-promote candidateContexts.",
      reRead: null,
    };
  }
  let existing: Record<string, unknown> | null = null;
  if (input.preserveExisting !== false) {
    const encoded = encodeURIComponent(input.branch);
    const getRc = input.runGh([
      "gh",
      "api",
      `repos/${input.repo}/branches/${encoded}/protection`,
    ]);
    if (getRc.returncode === 0 && getRc.stdout.trim()) {
      try {
        const parsed = JSON.parse(getRc.stdout) as unknown;
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>;
        }
      } catch {
        // Fall through with null existing — still refuse empty PUT below.
      }
    }
  }
  const built = buildMergeGateConfigurePayload(input.proposal, existing);
  if (!built.ok || built.payload === null) {
    return { ok: false, outcome: "refused", error: built.error, reRead: null };
  }
  const encoded = encodeURIComponent(input.branch);
  // Body is not piped through defaultRunGh; injectable runGh fixtures assert the
  // PUT argv and may ignore stdin. Production callers should supply a runGh that
  // posts built.payload (or use a higher-level writer). Non-zero PUT / missing
  // admin is cannot-configure, never opt-out (#1517).
  const putRc = input.runGh([
    "gh",
    "api",
    "-X",
    "PUT",
    `repos/${input.repo}/branches/${encoded}/protection`,
    "--input",
    "-",
  ]);
  if (putRc.returncode !== 0) {
    const err = putRc.stderr.trim() || `exit ${putRc.returncode}`;
    return {
      ok: false,
      outcome: "cannot-configure",
      error: `merge-gate configure write failed (cannot-configure, re-checkable): ${err}`,
      reRead: null,
    };
  }
  const reRead = fetchRequiredStatusContexts(input.repo, input.branch, input.runGh);
  if (reRead.resolutionFailed) {
    return {
      ok: false,
      outcome: "cannot-configure",
      error: `post-write inventory unknown: ${reRead.error || "resolutionFailed"}`,
      reRead,
    };
  }
  if (reRead.contexts.length === 0) {
    return {
      ok: false,
      outcome: "cannot-configure",
      error: "post-write inventory still empty; refuse claiming configured (#1517)",
      reRead,
    };
  }
  return { ok: true, outcome: "configured", error: "", reRead };
}
