import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  stepEnsureGitignoreEntry,
  stepEnsureGitignoreEvalEntries,
  stepSeedCandidatesLog,
} from "./gitignore.js";
import type {
  BootstrapResult,
  CacheFetchAllKwargs,
  CacheModule,
  FetchAllReport,
  ProgressWriter,
  RunBootstrapOptions,
  StepOutcome,
} from "./types.js";
import { PROGRESS_DEFAULT } from "./types.js";

export * from "./gitignore.js";
export * from "./types.js";

export const CACHE_DIR_NAME = ".deft-cache";
export const AUDIT_LOG_RELPATH = "vbrief/.eval/candidates.jsonl";
export const BACKFILL_FOLDERS = ["proposed", "pending", "active"] as const;
export const BOOTSTRAP_ACTOR = "agent:bootstrap";
export const DEFAULT_FETCH_TIMEOUT_S = 3600;
export const GIT_INFER_TIMEOUT_S = 10;

const CACHE_SOURCE = "github-issue";
const TOTAL_STEPS = 5;

const GIT_ORIGIN_RE =
  /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com[:/])([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*?)(?:\.git)?\/?\s*$/;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

const RUNNER_UNSET = Symbol("runner-unset");

const execFileAsync = promisify(execFile);

function defaultWhich(name: string): string | null {
  const locator = process.platform === "win32" ? "where" : "which";
  try {
    const result = execFileSync(locator, [name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = result.split(/\r?\n/).find((line) => line.trim().length > 0);
    return first !== undefined ? first.trim() : null;
  } catch {
    return null;
  }
}

/** Infer `owner/repo` from `git remote get-url origin`. */
export function inferRepoFromGit(cwd: string | null = null): string | null {
  if (defaultWhich("git") === null) return null;
  try {
    const proc = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: cwd ?? undefined,
      encoding: "utf8",
      timeout: GIT_INFER_TIMEOUT_S * 1000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const url = proc.trim();
    if (url.length === 0) return null;
    const m = GIT_ORIGIN_RE.exec(url);
    if (m === null) return null;
    return `${m[1]}/${m[2]}`;
  } catch {
    return null;
  }
}

function emitProgress(
  out: ProgressWriter,
  stepIndex: number,
  name: string,
  phase: string,
  detail = "",
): void {
  if (out === null) return;
  let line = `triage:bootstrap step ${stepIndex}/${TOTAL_STEPS} ${name} -- ${phase}`;
  if (detail.length > 0) line = `${line} (${detail})`;
  try {
    out(`${line}\n`);
  } catch {
    // observability must not fail bootstrap
  }
}

/** Run `func()` with an optional wall-clock cap (mirrors Python #952 watchdog). */
export async function runWithTimeout<T>(
  func: () => T | Promise<T>,
  timeoutS: number,
): Promise<{ completed: boolean; result: T | null; error: Error | null }> {
  if (!(timeoutS > 0)) {
    try {
      const result = await func();
      return { completed: true, result, error: null };
    } catch (error) {
      return {
        completed: true,
        result: null,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  let settled = false;
  let boxResult: T | typeof RUNNER_UNSET = RUNNER_UNSET;
  let boxError: Error | null = null;

  const runner = (async () => {
    try {
      boxResult = await func();
    } catch (error) {
      boxError = error instanceof Error ? error : new Error(String(error));
    } finally {
      settled = true;
    }
  })();

  const timeoutMs = timeoutS * 1000;
  const timedOut = await new Promise<boolean>((resolveTimeout) => {
    const timer = setTimeout(() => resolveTimeout(true), timeoutMs);
    runner.finally(() => {
      clearTimeout(timer);
      resolveTimeout(false);
    });
  });

  if (timedOut && !settled) {
    return { completed: false, result: null, error: null };
  }
  await runner;

  if (boxResult === RUNNER_UNSET && boxError === null) {
    return {
      completed: true,
      result: null,
      error: new Error(
        "worker thread terminated without completing (unhandled BaseException not propagated by Python threading)",
      ),
    };
  }
  return {
    completed: true,
    result: boxResult === RUNNER_UNSET ? null : boxResult,
    error: boxError,
  };
}

function resolveDeftRoot(explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) return resolve(explicit);
  if (process.env.DEFT_ROOT !== undefined && process.env.DEFT_ROOT.length > 0) {
    return resolve(process.env.DEFT_ROOT);
  }
  return resolve(process.cwd());
}

function cacheModulePresent(deftRoot: string): boolean {
  return existsSync(join(deftRoot, "scripts", "cache.py"));
}

async function invokePythonCacheFetchAll(
  deftRoot: string,
  kwargs: CacheFetchAllKwargs,
): Promise<FetchAllReport> {
  const payload = JSON.stringify({
    source: kwargs.source,
    repo: kwargs.repo,
    cache_root: kwargs.cacheRoot,
    batch_size: kwargs.batchSize ?? null,
    delay_ms: kwargs.delayMs ?? null,
    state: kwargs.state ?? null,
    limit: kwargs.limit ?? null,
    labels: kwargs.labels ?? null,
    author: kwargs.author ?? null,
  });
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(join(deftRoot, "scripts"))})
from cache import cache_fetch_all
raw = json.loads(sys.argv[1])
kwargs = {
    "source": raw["source"],
    "repo": raw["repo"],
    "cache_root": raw["cache_root"],
}
for key in ("batch_size", "delay_ms", "state", "limit", "author"):
    if raw[key] is not None:
        kwargs[key] = raw[key]
if raw["labels"]:
    kwargs["labels"] = tuple(raw["labels"])
report = cache_fetch_all(**kwargs)
out = {
    "succeeded": getattr(report, "succeeded", None),
    "failed": getattr(report, "failed", None),
    "skipped": getattr(report, "skipped", None),
}
summary_line = getattr(report, "summary_line", None)
if callable(summary_line):
    try:
        out["summary_message"] = summary_line(source=raw["source"], repo=raw["repo"])
    except TypeError:
        pass
print(json.dumps(out))
`;
  const { stdout } = await execFileAsync("uv", ["run", "python", "-c", script, payload], {
    cwd: deftRoot,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  const parsed = JSON.parse(String(stdout).trim()) as {
    succeeded?: number | null;
    failed?: number | null;
    skipped?: number | null;
    summary_message?: string;
  };
  const summaryMessage = parsed.summary_message;
  return {
    succeeded: parsed.succeeded,
    failed: parsed.failed,
    skipped: parsed.skipped,
    summaryLine: typeof summaryMessage === "string" ? () => summaryMessage : null,
  };
}

function loadDefaultCacheModule(deftRoot: string): CacheModule | null {
  if (!cacheModulePresent(deftRoot)) return null;
  return {
    cacheFetchAll(kwargs: CacheFetchAllKwargs): Promise<FetchAllReport> {
      return invokePythonCacheFetchAll(deftRoot, kwargs);
    },
  };
}

function nowIsoDefault(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function stepOutcome(
  name: string,
  ok: boolean,
  message: string,
  details: Record<string, unknown> = {},
  error: string | null = null,
): StepOutcome {
  return { name, ok, message, error, details };
}

/** Mirror upstream issues via cache_fetch_all. */
export async function stepPopulateCache(
  projectRoot: string,
  repo: string | null,
  options: {
    cacheModule?: CacheModule | null;
    batchSize?: number;
    delayMs?: number;
    state?: string;
    limit?: number;
    labels?: readonly string[];
    author?: string;
    fetchTimeoutS?: number | null;
    deftRoot?: string;
    runWithTimeoutFn?: RunBootstrapOptions["runWithTimeout"];
  } = {},
): Promise<StepOutcome> {
  let effectiveRepo = repo;
  if (effectiveRepo === null) {
    effectiveRepo = inferRepoFromGit(projectRoot);
  }
  if (effectiveRepo === null) {
    return stepOutcome(
      "populate_cache",
      true,
      "skipped (no --repo provided and could not infer from `git remote get-url origin`; pass --repo OWNER/NAME)",
      { skipped: "no-repo" },
    );
  }
  if (!REPO_RE.test(effectiveRepo)) {
    return stepOutcome(
      "populate_cache",
      false,
      `invalid --repo '${effectiveRepo}'`,
      {},
      "repo must be 'owner/name' (alphanumerics, '.', '_', '-' only)",
    );
  }

  const deftRoot = resolveDeftRoot(options.deftRoot);
  const cacheMod = options.cacheModule ?? loadDefaultCacheModule(deftRoot);
  if (cacheMod === null) {
    return stepOutcome(
      "populate_cache",
      true,
      "deferred (scripts/cache.py not present on this branch; re-run after rebase to populate via task cache:fetch-all)",
      { deferred: "cache-module-missing", repo: effectiveRepo },
    );
  }

  const kwargs: CacheFetchAllKwargs = {
    source: CACHE_SOURCE,
    repo: effectiveRepo,
    cacheRoot: join(projectRoot, CACHE_DIR_NAME),
    ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
    ...(options.delayMs !== undefined ? { delayMs: options.delayMs } : {}),
    ...(options.state !== undefined ? { state: options.state } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.labels !== undefined && options.labels.length > 0
      ? { labels: options.labels }
      : {}),
    ...(options.author !== undefined ? { author: options.author } : {}),
  };

  const effectiveTimeout =
    options.fetchTimeoutS !== undefined && options.fetchTimeoutS !== null
      ? options.fetchTimeoutS
      : DEFAULT_FETCH_TIMEOUT_S;
  const runTimeout = options.runWithTimeoutFn ?? runWithTimeout;
  const started = performance.now();

  const {
    completed,
    result: report,
    error: exc,
  } = await runTimeout(() => cacheMod.cacheFetchAll(kwargs), effectiveTimeout);
  const elapsed = (performance.now() - started) / 1000;

  if (!completed) {
    return stepOutcome(
      "populate_cache",
      false,
      `cache:fetch-all wall-clock timeout after ${effectiveTimeout}s for repo=${effectiveRepo} (an underlying \`task scm:issue:view\` subprocess is likely stuck; re-run with --fetch-timeout-s=0 to disable the watchdog or with a higher value, or shrink the run via --limit / --state=open)`,
      {
        repo: effectiveRepo,
        source: CACHE_SOURCE,
        fetch_timeout_s: effectiveTimeout,
        elapsed_s: Math.round(elapsed * 1000) / 1000,
        timed_out: true,
      },
      `step_populate_cache exceeded fetch_timeout_s=${effectiveTimeout}; see #952 for the watchdog rationale`,
    );
  }

  if (exc !== null) {
    return stepOutcome(
      "populate_cache",
      false,
      `cache:fetch-all raised ${exc.name} for repo=${effectiveRepo} (re-run after the underlying issue is resolved; see error for detail)`,
      {
        failed: "fetch-all-error",
        exc_type: exc.name,
        repo: effectiveRepo,
        elapsed_s: Math.round(elapsed * 1000) / 1000,
        fetch_timeout_s: effectiveTimeout,
      },
      exc.message,
    );
  }

  const fetchReport = report as FetchAllReport | null;
  const succeeded = fetchReport?.succeeded ?? null;
  const failed = fetchReport?.failed ?? null;
  const skipped = fetchReport?.skipped ?? null;
  let message =
    `cache:fetch-all source=${CACHE_SOURCE} repo=${effectiveRepo} ` +
    `succeeded=${succeeded} failed=${failed} skipped=${skipped}`;
  const summaryLine = fetchReport?.summaryLine;
  if (typeof summaryLine === "function") {
    try {
      message = summaryLine(CACHE_SOURCE, effectiveRepo);
    } catch {
      // keep legacy message
    }
  }

  return stepOutcome("populate_cache", true, message, {
    repo: effectiveRepo,
    source: CACHE_SOURCE,
    succeeded,
    failed,
    skipped,
    elapsed_s: Math.round(elapsed * 1000) / 1000,
    fetch_timeout_s: effectiveTimeout,
  });
}

function extractIssueNumber(vbriefData: Record<string, unknown>): number | null {
  const plan = vbriefData.plan;
  if (typeof plan !== "object" || plan === null) return null;
  const refs = (plan as Record<string, unknown>).references;
  if (!Array.isArray(refs)) return null;
  for (const ref of refs) {
    if (typeof ref !== "object" || ref === null) continue;
    const typed = ref as Record<string, unknown>;
    if (typed.type !== "x-vbrief/github-issue") continue;
    const uri = typed.uri;
    if (typeof uri !== "string") continue;
    const tail = uri.replace(/\/$/, "").split("/").pop() ?? "";
    if (/^\d+$/.test(tail)) return Number.parseInt(tail, 10);
  }
  return null;
}

function scanLifecycleFolder(folder: string): Array<[number, string]> {
  const results: Array<[number, string]> = [];
  if (!existsSync(folder)) return results;
  const entries = readdirSync(folder)
    .filter((name) => name.endsWith(".vbrief.json"))
    .sort();
  for (const name of entries) {
    const path = join(folder, name);
    try {
      const data = JSON.parse(readFileSync(path, { encoding: "utf8" })) as Record<string, unknown>;
      const issueNumber = extractIssueNumber(data);
      if (issueNumber !== null) results.push([issueNumber, path]);
    } catch {}
  }
  return results;
}

function existingAuditIssueNumbers(auditPath: string): Set<number> {
  if (!existsSync(auditPath)) return new Set();
  const seen = new Set<number>();
  try {
    for (const line of readFileSync(auditPath, { encoding: "utf8" }).split("\n")) {
      const stripped = line.trim();
      if (stripped.length === 0) continue;
      try {
        const entry = JSON.parse(stripped) as Record<string, unknown>;
        const n = entry.issue_number;
        if (typeof n === "number") seen.add(n);
      } catch {}
    }
  } catch {
    return new Set();
  }
  return seen;
}

function buildAuditEntry(
  repo: string,
  issueNumber: number,
  sourceFolder: string,
  nowIso: () => string,
) {
  return {
    decision_id: randomUUID(),
    timestamp: nowIso(),
    repo,
    issue_number: issueNumber,
    decision: "accept",
    actor: BOOTSTRAP_ACTOR,
    reason: `bootstrap backfill: vBRIEF already in vbrief/${sourceFolder}/ at opt-in time`,
  };
}

function appendAuditEntryDefault(auditPath: string, entry: Record<string, unknown>): void {
  mkdirSync(dirname(auditPath), { recursive: true });
  const sorted = Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(auditPath, `${JSON.stringify(sorted)}\n`, { encoding: "utf8", flag: "a" });
}

/** Backfill `accept` audit entries for items already in lifecycle folders. */
export function stepBackfillAuditLog(
  projectRoot: string,
  repo: string | null,
  options: {
    nowIso?: () => string;
    appendAuditEntry?: RunBootstrapOptions["appendAuditEntry"];
  } = {},
): StepOutcome {
  if (repo === null) {
    return stepOutcome(
      "backfill_audit_log",
      true,
      "skipped (no --repo provided; pass --repo OWNER/NAME to backfill)",
      { skipped: "no-repo" },
    );
  }

  const vbriefRoot = join(projectRoot, "vbrief");
  if (!existsSync(vbriefRoot)) {
    return stepOutcome(
      "backfill_audit_log",
      true,
      `skipped (no vbrief/ directory under ${projectRoot})`,
      { skipped: "no-vbrief" },
    );
  }

  const auditPath = join(projectRoot, AUDIT_LOG_RELPATH);
  const alreadyLogged = existingAuditIssueNumbers(auditPath);
  const nowIso = options.nowIso ?? nowIsoDefault;
  const appendEntry = options.appendAuditEntry ?? appendAuditEntryDefault;

  let appended = 0;
  let skippedExisting = 0;
  let skippedCancelled = 0;

  const cancelledDir = join(vbriefRoot, "cancelled");
  if (existsSync(cancelledDir)) {
    skippedCancelled = scanLifecycleFolder(cancelledDir).length;
  }

  for (const folderName of BACKFILL_FOLDERS) {
    const folderPath = join(vbriefRoot, folderName);
    for (const [issueNumber] of scanLifecycleFolder(folderPath)) {
      if (alreadyLogged.has(issueNumber)) {
        skippedExisting += 1;
        continue;
      }
      const entry = buildAuditEntry(repo, issueNumber, folderName, nowIso);
      try {
        appendEntry(auditPath, entry);
      } catch (error) {
        const exc = error instanceof Error ? error : new Error(String(error));
        return stepOutcome(
          "backfill_audit_log",
          false,
          `append failed at issue #${issueNumber} after ${appended} successful writes`,
          { appended, skipped_existing: skippedExisting, skipped_cancelled: skippedCancelled },
          `${exc.name}: ${exc.message}`,
        );
      }
      appended += 1;
      alreadyLogged.add(issueNumber);
    }
  }

  return stepOutcome(
    "backfill_audit_log",
    true,
    `appended ${appended} accepted entries; skipped ${skippedExisting} (already logged); skipped ${skippedCancelled} (cancelled/, no reanimation)`,
    {
      appended,
      skipped_existing: skippedExisting,
      skipped_cancelled: skippedCancelled,
      audit_path: auditPath,
    },
  );
}

/** Render a recap the operator sees at the end of bootstrap. */
export function formatSummary(result: BootstrapResult): string {
  const lines = ["", "Triage v1 bootstrap recap:"];
  for (const step of result.steps) {
    const mark = step.ok ? "✓" : "✗";
    lines.push(`  ${mark} ${step.name}: ${step.message}`);
    if (step.error) lines.push(`      error: ${step.error}`);
  }
  if (result.exitCode === 0) {
    lines.push("");
    lines.push("Next steps:");
    lines.push(
      "  task cache:fetch-all -- --source=github-issue --repo OWNER/NAME   # refresh the cache (#883 Story 2)",
    );
    lines.push(
      "  task cache:get -- github-issue OWNER/NAME/<N>            # inspect cached issue N",
    );
    lines.push(
      "  task triage:accept -- --issue <N> --repo OWNER/NAME      # accept issue N (#845 Story 3)",
    );
    lines.push(
      "  task triage:reject -- --issue <N> --repo OWNER/NAME --reason 'why' # reject issue N",
    );
    lines.push(
      "  task triage:bulk-accept -- --repo OWNER/NAME --label adoption-blocker # bulk accept",
    );
    lines.push(
      "  task triage:refresh-active                              # pre-swarm freshness gate",
    );
  }
  return lines.join("\n");
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortKeysDeep(item));
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort((a, b) => a.localeCompare(b))
        .map((key) => [key, sortKeysDeep(obj[key])]),
    );
  }
  return value;
}

function pythonJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => pythonJson(item)).join(", ")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
  return `{${keys.map((key) => `${JSON.stringify(key)}: ${pythonJson(obj[key])}`).join(", ")}}`;
}

/** Render the structured `--json` payload. */
export function formatJson(result: BootstrapResult): string {
  const payload = sortKeysDeep({
    project_root: result.projectRoot,
    repo: result.repo,
    exit_code: result.exitCode,
    steps: result.steps.map((s) => ({
      name: s.name,
      ok: s.ok,
      message: s.message,
      error: s.error ?? null,
      details: s.details,
    })),
  });
  return pythonJson(payload);
}

function progressSink(progress: RunBootstrapOptions["progress"]): ProgressWriter {
  if (progress === PROGRESS_DEFAULT) {
    return (line: string) => {
      process.stderr.write(line);
    };
  }
  if (progress === undefined) {
    return (line: string) => {
      process.stderr.write(line);
    };
  }
  return progress ?? null;
}

/** Run the bootstrap pipeline, returning the aggregate result. */
export async function runBootstrap(
  projectRoot: string,
  repo: string | null,
  options: RunBootstrapOptions = {},
): Promise<BootstrapResult> {
  const root = resolve(projectRoot);
  const progress = progressSink(options.progress);

  let effectiveRepo = repo;
  if (effectiveRepo === null) {
    const infer = options.inferRepoFromGit ?? inferRepoFromGit;
    effectiveRepo = infer(root);
  }

  const steps: StepOutcome[] = [];
  const repoDetail = effectiveRepo !== null ? `repo=${effectiveRepo}` : "repo=<unresolved>";
  const effectiveTimeout =
    options.fetchTimeoutS !== undefined && options.fetchTimeoutS !== null
      ? options.fetchTimeoutS
      : DEFAULT_FETCH_TIMEOUT_S;
  const timeoutDetail = `fetch_timeout_s=${effectiveTimeout}`;

  emitProgress(progress, 1, "populate_cache", "starting", `${repoDetail}; ${timeoutDetail}`);
  const populate = await stepPopulateCache(root, effectiveRepo, {
    cacheModule: options.cacheModule,
    batchSize: options.batchSize,
    delayMs: options.delayMs,
    state: options.state,
    limit: options.limit,
    labels: options.labels,
    author: options.author,
    fetchTimeoutS: options.fetchTimeoutS,
    deftRoot: options.deftRoot,
    runWithTimeoutFn: options.runWithTimeout,
  });
  steps.push(populate);
  const populatePhase = populate.ok ? "done" : populate.details.timed_out ? "timeout" : "error";
  emitProgress(progress, 1, "populate_cache", populatePhase, populate.message);

  emitProgress(progress, 2, "backfill_audit_log", "starting", repoDetail);
  const backfill = stepBackfillAuditLog(root, effectiveRepo, {
    nowIso: options.nowIso,
    appendAuditEntry: options.appendAuditEntry,
  });
  steps.push(backfill);
  emitProgress(progress, 2, "backfill_audit_log", backfill.ok ? "done" : "error", backfill.message);

  emitProgress(progress, 3, "ensure_gitignore_entry", "starting");
  const giCache = stepEnsureGitignoreEntry(root);
  steps.push(giCache);
  emitProgress(
    progress,
    3,
    "ensure_gitignore_entry",
    giCache.ok ? "done" : "error",
    giCache.message,
  );

  emitProgress(progress, 4, "ensure_gitignore_eval_entries", "starting");
  const giEval = stepEnsureGitignoreEvalEntries(root);
  steps.push(giEval);
  emitProgress(
    progress,
    4,
    "ensure_gitignore_eval_entries",
    giEval.ok ? "done" : "error",
    giEval.message,
  );

  emitProgress(progress, 5, "seed_candidates_log", "starting");
  const seed = stepSeedCandidatesLog(root);
  steps.push(seed);
  emitProgress(progress, 5, "seed_candidates_log", seed.ok ? "done" : "error", seed.message);

  const exitCode = steps.some((step) => !step.ok) ? 1 : 0;
  return {
    projectRoot: root,
    repo: effectiveRepo,
    steps,
    exitCode,
  };
}

export function normaliseLabelFilter(raw: readonly string[] | null | undefined): readonly string[] {
  if (raw === undefined || raw === null || raw.length === 0) return [];
  const out: string[] = [];
  for (const value of raw) {
    for (const item of value.split(",")) {
      const trimmed = item.trim();
      if (trimmed.length > 0) out.push(trimmed);
    }
  }
  return out;
}

export function defaultFetchTimeoutFromEnv(): number {
  const raw = process.env.DEFT_BOOTSTRAP_FETCH_TIMEOUT_S;
  if (raw === undefined || raw.length === 0) return DEFAULT_FETCH_TIMEOUT_S;
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed)) return DEFAULT_FETCH_TIMEOUT_S;
  return Math.max(0, parsed);
}
