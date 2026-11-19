/**
 * preflight.ts -- Native TypeScript release Step-5 pre-flight (#2022 Phase 1).
 *
 * Promotes the context-aware `task check` orchestrator (check/orchestrator.ts)
 * to the primary release pre-flight, replacing the removed `ci_local.py`
 * python-bridge shim. The maintainer release runs in the framework-source
 * context, so the framework root equals the project root and the orchestrator
 * dispatches `check:framework-source`.
 *
 * #6041: Step 5 runs host vitest `--coverage` (thresholds enforced on host).
 * Tip-SHA GHA coverage-of-record cites are retired from the success path.
 */
import { spawnSync } from "node:child_process";
import { extractGateCause } from "../check/named-cause.js";
import type { CachedCheckCompletion, CheckOrchestratorSeams } from "../check/orchestrator.js";
import { dispatchTaskCheck } from "../check/orchestrator.js";
import { suiteActuallyRan } from "../check/suite-gate-supervisor.js";
import { defaultRunGh } from "../pr-merge-readiness/gh.js";
import type { RunGhFn } from "../pr-merge-readiness/types.js";
import { MERGE_GATE_TASK_CHECK_NAME } from "../pr-wait-mergeable/constants.js";
import {
  evaluateAlwaysOnNamedMergeGate,
  type NamedMergeGateFn,
} from "../pr-wait-mergeable/semantic-green.js";
import {
  ENV_CHECK_AC_ONLY,
  ENV_CHECK_MODE,
  ENV_HYGIENE_ADVISORY,
} from "../product-first-done-gate/index.js";
import { countFailedTestsFromSanitizedOutput } from "./auto-hatch.js";
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

/** Seams for test isolation of the native release pre-flight. */
export interface ReleasePreflightSeams {
  /** Override named Merge gate tip read (#6071). */
  readonly namedMergeGateFn?: NamedMergeGateFn;
  readonly runGh?: RunGhFn;
  readonly tipSha?: string | null;
  readonly skipNamedMergeGate?: boolean;
  /**
   * When true, run only the named Merge gate then return (suite-stamp path).
   * Does not run the full framework-source check dispatcher (#6071 Greptile).
   */
  readonly skipCi?: boolean;
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
 * Thin Step 5 failure reason. Encode a failed-test count from extractGateCause
 * of the suite tee; never attach raw suite bytes (#4244 / #3282).
 */
export function formatReleaseCheckFailureReason(
  code: number,
  completion: CachedCheckCompletion | undefined,
): string {
  const failedGate =
    completion?.gates.find((g) => g.exit_code !== 0 && g.exit_code != null) ??
    completion?.gates.find((g) => g.status === "failed");
  const gateId = failedGate?.id?.trim();
  const tee = completion?.suiteTeeText ?? "";
  const cause = extractGateCause(tee, "", code, undefined, gateId);
  const failedTests = countFailedTestsFromSanitizedOutput(cause);
  if (failedTests !== null && failedTests > 0) {
    return `task check failed (exit ${code}; ${failedTests} failed tests)`;
  }
  return `task check failed (exit ${code})`;
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
  // #6071 P5: refuse unless named Merge gate is successful completed on tip
  // (outside skipCi/suite-stamp callers — those skip runReleaseCheck entirely).
  if (seams.skipNamedMergeGate !== true) {
    const tipSha =
      seams.tipSha ??
      (() => {
        const result = spawnSync("git", ["rev-parse", "HEAD"], {
          cwd: projectRoot,
          encoding: "utf8",
          shell: false,
        });
        if (result.status !== 0) return null;
        const sha = (result.stdout ?? "").trim();
        return sha.length > 0 ? sha : null;
      })();
    const namedFn = seams.namedMergeGateFn ?? evaluateAlwaysOnNamedMergeGate;
    // Prefer checkout origin over hard-coded DEFAULT_REPO so forks / non-default remotes gate the right tip.
    const namedRepo = (() => {
      const fromEnv = (
        seams.checkSeams?.env?.GH_REPO ??
        seams.checkSeams?.env?.GITHUB_REPOSITORY ??
        ""
      )
        .toString()
        .trim();
      if (fromEnv.length > 0) return fromEnv;
      try {
        const result = spawnSync("git", ["remote", "get-url", "origin"], {
          cwd: projectRoot,
          encoding: "utf8",
          shell: false,
        });
        if (result.status === 0) {
          const url = (result.stdout ?? "").trim();
          // Allow dots inside the repo segment; only strip a trailing .git.
          const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/i.exec(url);
          const captured = m?.[1];
          if (captured !== undefined && captured.length > 0) {
            return captured;
          }
        }
      } catch {
        /* fall through */
      }
      return DEFAULT_REPO;
    })();
    const named = namedFn(null, namedRepo, {
      runGh: seams.runGh ?? defaultRunGh,
      tipSha,
      projectRoot,
      env: seams.checkSeams?.env,
    });
    if (!named.ok) {
      return [
        false,
        `${MERGE_GATE_TASK_CHECK_NAME} not successful completed on tip ${tipSha ?? "<unknown>"}; ` +
          `release refused (#6071). ${named.error ?? ""}`.trim(),
      ];
    }
  }

  if (seams.skipCi === true) {
    return [true, "named Merge gate ok (skipCi suite-stamp path)"];
  }

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
    return [true, "ran native TypeScript task check (host coverage at Step 5)"];
  }
  return [false, formatReleaseCheckFailureReason(code, completion)];
}
