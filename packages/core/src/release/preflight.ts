/**
 * preflight.ts -- Native TypeScript release Step-5 pre-flight (#2022 Phase 1).
 *
 * Promotes the context-aware `task check` orchestrator (check/orchestrator.ts)
 * to the primary release pre-flight, replacing the removed `ci_local.py`
 * python-bridge shim. The maintainer release runs in the framework-source
 * context, so the framework root equals the project root and the orchestrator
 * dispatches `check:framework-source`.
 *
 * #5026: Step 5 drops host vitest `--coverage`; tip-SHA GHA coverage is
 * coverage-of-record and is cited fail-closed on the success tee.
 */
import { spawnSync } from "node:child_process";
import type { CachedCheckCompletion, CheckOrchestratorSeams } from "../check/orchestrator.js";
import { dispatchTaskCheck } from "../check/orchestrator.js";
import { suiteActuallyRan } from "../check/suite-gate-supervisor.js";
import { defaultRunGh } from "../pr-merge-readiness/gh.js";
import type { RunGhFn } from "../pr-merge-readiness/types.js";
import {
  ENV_CHECK_AC_ONLY,
  ENV_CHECK_MODE,
  ENV_HYGIENE_ADVISORY,
} from "../product-first-done-gate/index.js";
import {
  COVERAGE_DEBT_ENV,
  DEFAULT_REPO,
  RELEASE_CHECK_TIMEOUT_MS,
  RELEASE_PREFLIGHT_ENV,
} from "./constants.js";

export interface ReleaseCheckEnvOptions {
  readonly base?: NodeJS.ProcessEnv;
  readonly allowCoverageDebtIssue?: number | null;
}

/** Step-5-only env: branch bypass plus release pre-flight cache staleness tolerance (#2386). */
export function releaseCheckEnv(options: ReleaseCheckEnvOptions = {}): NodeJS.ProcessEnv {
  const base = options.base ?? process.env;
  const allowCoverageDebtIssue = options.allowCoverageDebtIssue ?? null;
  const env: NodeJS.ProcessEnv = {
    ...base,
    [RELEASE_PREFLIGHT_ENV]: "1",
    [ENV_CHECK_MODE]: "full",
  };
  delete env[ENV_CHECK_AC_ONLY];
  delete env[ENV_HYGIENE_ADVISORY];
  // Step 5 must not inherit DEFT_ALLOW_* from releaseSubprocessEnv / parent shell —
  // assertNoDeftAllowEscape unit tests treat any DEFT_ALLOW_* as a measured violation.
  for (const key of Object.keys(env)) {
    if (key.startsWith("DEFT_ALLOW_")) delete env[key];
  }
  if (allowCoverageDebtIssue !== null) {
    env[COVERAGE_DEBT_ENV] = String(allowCoverageDebtIssue);
  }
  return env;
}

export interface CoverageOfRecordCheckRun {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string;
  readonly htmlUrl?: string;
  readonly id?: number;
}

export interface CoverageOfRecordCite {
  readonly tipSha: string;
  readonly runId: string;
  readonly checkName: string;
}

export type CoverageOfRecordResult =
  | { readonly ok: true; readonly cite: CoverageOfRecordCite }
  | { readonly ok: false; readonly reason: string };

/** Seams for test isolation of the native release pre-flight. */
export interface ReleasePreflightSeams {
  /** Override the check dispatcher (default: dispatchTaskCheck from check/orchestrator). */
  readonly dispatchCheck?: (
    frameworkRoot: string,
    projectRoot: string,
    seams?: CheckOrchestratorSeams & {
      readonly deadlineAtMs?: number;
      readonly nowMs?: () => number;
    },
  ) => number;
  /** Seams forwarded to the underlying check orchestrator (e.g. taskBin, spawnFn). */
  readonly checkSeams?: CheckOrchestratorSeams;
  /** Clock seam so tests can mint a deterministic Step 5 deadline (#4801). */
  readonly nowMs?: () => number;
  /** Tip-SHA GHA coverage-of-record cite (#5026). Default: live git + gh REST. */
  readonly resolveCoverageOfRecord?: (projectRoot: string) => CoverageOfRecordResult;
}

/** Aggregator or TypeScript lane job that executed ci-lane coverage. */
export function isCoverageOfRecordCheckName(name: string): boolean {
  const n = name.trim();
  if (n === "TypeScript (build + lint + test)") return true;
  return /^typescript\s*\([^)]*\)\s*\/\s*run$/i.test(n);
}

export function extractActionsRunIdFromHtmlUrl(htmlUrl: string): string | null {
  const match = /\/actions\/runs\/(\d+)(?:\/|$)/.exec(htmlUrl);
  return match?.[1] ?? null;
}

export function evaluateTipShaCoverageOfRecord(
  tipSha: string,
  checkRuns: readonly CoverageOfRecordCheckRun[],
): CoverageOfRecordResult {
  if (!/^[0-9a-f]{7,40}$/i.test(tipSha)) {
    return { ok: false, reason: `invalid tip SHA for coverage-of-record cite (${tipSha})` };
  }
  const successes = checkRuns.filter(
    (run) =>
      run.status === "completed" &&
      run.conclusion === "success" &&
      isCoverageOfRecordCheckName(run.name),
  );
  if (successes.length === 0) {
    return {
      ok: false,
      reason:
        `no green tip-SHA GHA coverage-of-record check on ${tipSha.slice(0, 12)} ` +
        "(need TypeScript aggregator or lane / run success; merge-base prose is not enough; not --skip-ci)",
    };
  }
  const preferred =
    successes.find((run) => run.name === "TypeScript (build + lint + test)") ?? successes[0];
  if (preferred === undefined) {
    return {
      ok: false,
      reason: `no green tip-SHA GHA coverage-of-record check on ${tipSha.slice(0, 12)}`,
    };
  }
  // Workflow run id only — never fall back to check-run id (different namespace).
  const runId =
    preferred.htmlUrl !== undefined ? extractActionsRunIdFromHtmlUrl(preferred.htmlUrl) : null;
  if (runId === null) {
    return {
      ok: false,
      reason:
        `green coverage-of-record check ${preferred.name} on ${tipSha.slice(0, 12)} ` +
        "lacks parseable actions/runs URL (check-run id is not a workflow run id)",
    };
  }
  return {
    ok: true,
    cite: { tipSha, runId, checkName: preferred.name },
  };
}

export function formatCoverageOfRecordCite(cite: CoverageOfRecordCite): string {
  return `coverage-of-record gha-run=${cite.runId} tip=${cite.tipSha} check=${cite.checkName}`;
}

function resolveHeadShaForCite(projectRoot: string): string | null {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: projectRoot,
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) return null;
  const sha = (result.stdout ?? "").trim();
  return sha.length > 0 ? sha : null;
}

function resolveRepoForCite(): string {
  // Framework release cuts cite coverage on deftai/directive tip SHA (#5026).
  return DEFAULT_REPO;
}

function fetchCoverageCheckRuns(
  repo: string,
  tipSha: string,
  runGh: RunGhFn,
): { checkRuns: CoverageOfRecordCheckRun[]; error: string } {
  const rc = runGh(["gh", "api", `repos/${repo}/commits/${tipSha}/check-runs?per_page=100`]);
  if (rc.returncode !== 0) {
    return {
      checkRuns: [],
      error: `gh api /commits/<sha>/check-runs failed: ${rc.stderr.trim()}`,
    };
  }
  if (!rc.stdout.trim()) {
    return { checkRuns: [], error: "empty body from gh api /commits/<sha>/check-runs" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rc.stdout) as unknown;
  } catch (exc: unknown) {
    const message = exc instanceof Error ? exc.message : String(exc);
    return { checkRuns: [], error: `could not parse check-runs JSON: ${message}` };
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { checkRuns: [], error: "unexpected check-runs JSON shape (not a dict)" };
  }
  const runs = (payload as Record<string, unknown>).check_runs;
  if (!Array.isArray(runs)) {
    return { checkRuns: [], error: "check-runs JSON missing check_runs list" };
  }
  const checkRuns: CoverageOfRecordCheckRun[] = [];
  for (const run of runs) {
    if (run === null || typeof run !== "object" || Array.isArray(run)) continue;
    const record = run as Record<string, unknown>;
    const name = typeof record.name === "string" && record.name.length > 0 ? record.name : "";
    if (name.length === 0) continue;
    const status = typeof record.status === "string" ? record.status : "unknown";
    const conclusion = typeof record.conclusion === "string" ? record.conclusion : "none";
    const htmlUrl = typeof record.html_url === "string" ? record.html_url : undefined;
    const id = typeof record.id === "number" && Number.isFinite(record.id) ? record.id : undefined;
    checkRuns.push({
      name,
      status,
      conclusion,
      ...(htmlUrl !== undefined ? { htmlUrl } : {}),
      ...(id !== undefined ? { id } : {}),
    });
  }
  return { checkRuns, error: "" };
}

export function defaultResolveCoverageOfRecord(
  projectRoot: string,
  runGh: RunGhFn = defaultRunGh,
): CoverageOfRecordResult {
  const tipSha = resolveHeadShaForCite(projectRoot);
  if (tipSha === null) {
    return { ok: false, reason: "could not resolve tip SHA for coverage-of-record cite" };
  }
  const repo = resolveRepoForCite();
  const fetched = fetchCoverageCheckRuns(repo, tipSha, runGh);
  if (fetched.error.length > 0) {
    return { ok: false, reason: fetched.error };
  }
  return evaluateTipShaCoverageOfRecord(tipSha, fetched.checkRuns);
}

/** Step 5 124 copy names the hung gate from completion.gates (#4801). */
export function formatReleaseCheckTimeoutMessage(
  timeoutMs: number,
  completion: CachedCheckCompletion | undefined,
): string {
  const hung =
    completion?.gates.find((g) => g.exit_code === 124) ??
    completion?.gates.find((g) => g.status === "failed");
  const gate = hung?.id?.trim() ?? "";
  const minutes = timeoutMs / 60_000;
  if (gate.length > 0) {
    return `task check timed out after ${minutes}m at gate ${gate} (see docs/RELEASING.md)`;
  }
  return `task check timed out after ${minutes}m (see docs/RELEASING.md)`;
}

/**
 * Run the native TypeScript `task check` as the release pre-flight.
 *
 * Returns the pipeline's standard `[ok, message]` tuple. The maintainer release
 * cuts the framework itself, so we pass `projectRoot` as both the framework root
 * and the project root -- the orchestrator then resolves the framework-source
 * context and runs `check:framework-source`.
 */
export function runReleaseCheck(
  projectRoot: string,
  seams: ReleasePreflightSeams = {},
  allowCoverageDebtIssue: number | null = null,
): [boolean, string] {
  const dispatch = seams.dispatchCheck ?? dispatchTaskCheck;
  let completion: CachedCheckCompletion | undefined;
  const priorComplete = seams.checkSeams?.onCheckComplete;
  const nowFn = seams.nowMs ?? Date.now;
  const wallMs = seams.checkSeams?.timeoutMs ?? RELEASE_CHECK_TIMEOUT_MS;
  const deadlineAtMs = nowFn() + wallMs;
  const checkSeams = {
    ...seams.checkSeams,
    timeoutMs: wallMs,
    deadlineAtMs,
    ...(seams.nowMs !== undefined ? { nowMs: seams.nowMs } : {}),
    env: releaseCheckEnv({
      base: seams.checkSeams?.env ?? process.env,
      allowCoverageDebtIssue,
    }),
    onCheckComplete: (snapshot: CachedCheckCompletion) => {
      completion = snapshot;
      priorComplete?.(snapshot);
    },
  };
  const code = dispatch(projectRoot, projectRoot, checkSeams);
  if (code === 124) {
    return [false, formatReleaseCheckTimeoutMessage(wallMs, completion)];
  }
  if (code === 0) {
    if (completion !== undefined) {
      const suite = completion.gates.find((g) => g.id === "ts:check-lane");
      const ran = suiteActuallyRan({
        status: suite?.status,
        teeText: completion.suiteTeeText,
      });
      if (!ran) {
        return [false, "suite gate did not run (ts:check-lane skip/SKIP_NOTICE)"];
      }
    }
    const resolveCite = seams.resolveCoverageOfRecord ?? defaultResolveCoverageOfRecord;
    const citeResult = resolveCite(projectRoot);
    if (!citeResult.ok) {
      return [false, citeResult.reason];
    }
    return [
      true,
      `ran native TypeScript task check; ${formatCoverageOfRecordCite(citeResult.cite)}`,
    ];
  }
  return [false, `task check failed (exit ${code})`];
}
