/**
 * preflight.ts -- Native TypeScript release Step-5 pre-flight (#2022 Phase 1).
 *
 * Promotes the context-aware `task check` orchestrator (check/orchestrator.ts)
 * to the primary release pre-flight, replacing the removed `ci_local.py`
 * python-bridge shim. The maintainer release runs in the framework-source
 * context, so the framework root equals the project root and the orchestrator
 * dispatches `check:framework-source`.
 */
import { type CheckOrchestratorSeams, dispatchTaskCheck } from "../check/orchestrator.js";
import { RELEASE_PREFLIGHT_ENV } from "./constants.js";
import { releaseSubprocessEnv } from "./git.js";

/** Step-5-only env: branch bypass plus release pre-flight cache staleness tolerance (#2386). */
export function releaseCheckEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...releaseSubprocessEnv(base),
    [RELEASE_PREFLIGHT_ENV]: "1",
  };
}

/** Seams for test isolation of the native release pre-flight. */
export interface ReleasePreflightSeams {
  /** Override the check dispatcher (default: dispatchTaskCheck from check/orchestrator). */
  readonly dispatchCheck?: (
    frameworkRoot: string,
    projectRoot: string,
    seams?: CheckOrchestratorSeams,
  ) => number;
  /** Seams forwarded to the underlying check orchestrator (e.g. taskBin, spawnFn). */
  readonly checkSeams?: CheckOrchestratorSeams;
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
): [boolean, string] {
  const dispatch = seams.dispatchCheck ?? dispatchTaskCheck;
  const checkSeams: CheckOrchestratorSeams = {
    ...seams.checkSeams,
    env: releaseCheckEnv(seams.checkSeams?.env ?? process.env),
  };
  const code = dispatch(projectRoot, projectRoot, checkSeams);
  if (code === 0) {
    return [true, "ran native TypeScript task check"];
  }
  return [false, `task check failed (exit ${code})`];
}
