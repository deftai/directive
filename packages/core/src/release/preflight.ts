/**
 * preflight.ts -- Native TypeScript release Step-5 pre-flight (#2022 Phase 1).
 *
 * Promotes the context-aware `task check` orchestrator (check/orchestrator.ts)
 * to the primary release pre-flight, replacing the removed `ci_local.py`
 * python-bridge shim. The maintainer release runs in the framework-source
 * context, so the framework root equals the project root and the orchestrator
 * dispatches `check:framework-source`.
 */
import type { CachedCheckCompletion, CheckOrchestratorSeams } from "../check/orchestrator.js";
import { dispatchTaskCheck } from "../check/orchestrator.js";
import { suiteActuallyRan } from "../check/suite-gate-supervisor.js";
import {
  ENV_CHECK_AC_ONLY,
  ENV_CHECK_MODE,
  ENV_HYGIENE_ADVISORY,
} from "../product-first-done-gate/index.js";
import { COVERAGE_DEBT_ENV, RELEASE_CHECK_TIMEOUT_MS, RELEASE_PREFLIGHT_ENV } from "./constants.js";
import { releaseSubprocessEnv } from "./git.js";

export interface ReleaseCheckEnvOptions {
  readonly base?: NodeJS.ProcessEnv;
  readonly allowCoverageDebtIssue?: number | null;
}

/** Step-5-only env: branch bypass plus release pre-flight cache staleness tolerance (#2386). */
export function releaseCheckEnv(options: ReleaseCheckEnvOptions = {}): NodeJS.ProcessEnv {
  const base = options.base ?? process.env;
  const allowCoverageDebtIssue = options.allowCoverageDebtIssue ?? null;
  const env: NodeJS.ProcessEnv = {
    ...releaseSubprocessEnv(base),
    [RELEASE_PREFLIGHT_ENV]: "1",
    [ENV_CHECK_MODE]: "full",
  };
  delete env[ENV_CHECK_AC_ONLY];
  delete env[ENV_HYGIENE_ADVISORY];
  if (allowCoverageDebtIssue !== null) {
    env[COVERAGE_DEBT_ENV] = String(allowCoverageDebtIssue);
  } else {
    // Scrub ambient parent-shell debt so nested unit tests and unpaid checks
    // do not inherit a prior --allow-coverage-debt from the release process (#2618).
    delete env[COVERAGE_DEBT_ENV];
  }
  return env;
}

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
    return [true, "ran native TypeScript task check"];
  }
  return [false, `task check failed (exit ${code})`];
}
