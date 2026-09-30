/**
 * check/orchestrator.ts -- Context-aware `task check` orchestrator (#1854 / #1883).
 *
 * TypeScript port of scripts/_project_context.py dispatch_task_check().
 * Detects whether we are running in the framework-source context or a
 * vendored-consumer context (#1519) and dispatches to the appropriate
 * aggregate Taskfile target.
 *
 * Default path uses the cached sequential gate runner (#1713) with
 * fast-before-slow ordering (#3188): cheap gates run before `ts:check-lane`
 * (vitest+coverage). A fast-gate failure aborts before the suite starts.
 * Opaque / generic-only named-cause fallbacks on that path are bugs (#1883).
 *
 * Exit codes (three-state, mirrors _project_context.py):
 *   0 -- all gates passed
 *   1 -- one or more gates failed
 *   2 -- config error (missing args, task spawn error, etc.)
 */

import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { dispatchCachedTaskCheck } from "./cached-orchestrator.js";
import {
  evaluateConsumerGateIntegrity,
  formatConsumerGateIntegrityFailure,
} from "./consumer-gate-integrity.js";
import {
  CONSUMER_HEADER_PLACEHOLDER_GATE_ID,
  evaluateConsumerHeaderPlaceholderAtRoot,
} from "./consumer-header-placeholder.js";
import { type CheckOrchestratorSeams, resolveCheckTarget } from "./context.js";
import { CONSUMER_CHECK_GATES, checkGateId, FRAMEWORK_CHECK_GATES } from "./gate-lists.js";
import { listCompositionGatesMissingSpecificRemedies } from "./named-cause.js";
import {
  CHECK_EMPTY_PLANNING_NARRATIVES_GATE_ID,
  checkRejectsEmptyPlanningNarratives,
  evaluateCheckPersistedPlanningNarratives,
} from "./persisted-planning-narratives-gate.js";

export type {
  CachedCheckCompletion,
  CheckOrchestratorOptions,
  CheckOrchestratorSeams,
} from "./context.js";
export { isFrameworkRepoRoot, isFrameworkSourceContext, resolveCheckTarget } from "./context.js";

/**
 * Composition gates (framework ∪ consumer) still missing a concrete GATE_REMEDIES
 * entry — residual audit for the named-cause seam (#1883). Empty is the ship bar.
 */
export function auditCheckCompositionNamedRemedies(): readonly string[] {
  const ids = [...new Set([...FRAMEWORK_CHECK_GATES, ...CONSUMER_CHECK_GATES].map(checkGateId))];
  return listCompositionGatesMissingSpecificRemedies(ids);
}

/**
 * Dispatch to the context-appropriate `task check` aggregate target.
 *
 * Invokes `task [target] --taskfile <frameworkRoot>/Taskfile.yml` from the
 * appropriate cwd so that go-task's `USER_WORKING_DIR` resolves correctly:
 *   - framework-source: cwd = frameworkRoot (USER_WORKING_DIR = frameworkRoot ✓)
 *   - consumer:         cwd = projectRoot  (USER_WORKING_DIR = projectRoot  ✓)
 */
export function dispatchTaskCheck(
  frameworkRoot: string,
  projectRoot: string,
  seams: CheckOrchestratorSeams = {},
): number {
  const resolvedFramework = resolve(frameworkRoot);
  const resolvedProject = resolve(projectRoot);
  const useTaskCache = seams.useTaskCache !== false && !seams.noCache;

  if (useTaskCache) {
    return dispatchCachedTaskCheck(resolvedFramework, resolvedProject, seams);
  }

  const taskfilePath = join(resolvedFramework, "Taskfile.yml");
  const taskBin = seams.taskBin ?? "task";

  const target = resolveCheckTarget(resolvedFramework, resolvedProject);
  const cwd = target === "check:framework-source" ? resolvedFramework : resolvedProject;

  // #3070: pre-flight consumer check-graph integrity (same path as cached
  // orchestrator) so uncached aggregate shelling also fails with recovery text.
  if (target === "check:consumer") {
    const integrity = evaluateConsumerGateIntegrity(resolvedFramework);
    if (!integrity.ok) {
      process.stderr.write(formatConsumerGateIntegrityFailure(integrity));
      return 2;
    }
  }

  // #5176 Prefer-A: refuse empty PD narratives only with product-mutation
  // completion (mirror #4544). Missing PD and scaffold-empty stay legal here;
  // setup Phase 2 verify stays unconditional. Do not shell the verify task
  // from Taskfile check deps — that exits 2 on missing PD.
  const planning = evaluateCheckPersistedPlanningNarratives(resolvedProject);
  if (checkRejectsEmptyPlanningNarratives(planning.narratives, planning.productMutation)) {
    process.stderr.write(`check: ${planning.narratives.message}\n`);
    process.stderr.write(
      `check: gate ${CHECK_EMPTY_PLANNING_NARRATIVES_GATE_ID} failed (exit 1)\n` +
        `  cause: ${planning.narratives.cause}\n` +
        `  remedy: ${planning.narratives.remedy}\n`,
    );
    return 1;
  }

  // #4544 Prefer-A: fail closed on uncached / Taskfile path too (cached
  // orchestrator already runs this before composition).
  const headerPlaceholder = evaluateConsumerHeaderPlaceholderAtRoot(resolvedProject);
  if (!headerPlaceholder.ok) {
    process.stderr.write(`${headerPlaceholder.message}\n`);
    process.stderr.write(
      `check: gate ${CONSUMER_HEADER_PLACEHOLDER_GATE_ID} failed (exit 1)\n` +
        `  cause: ${headerPlaceholder.reason}\n` +
        `  remedy: ${headerPlaceholder.message}\n`,
    );
    return 1;
  }

  const spawn = seams.spawnFn ?? defaultSpawn;
  const result = spawn(taskBin, [target, "--taskfile", taskfilePath], {
    cwd,
    stdio: "inherit",
    env: seams.env,
    timeoutMs: seams.timeoutMs,
  });

  if (result.error !== undefined) {
    // #3282: named cause + remedy instead of bare spawn failure.
    const detail = result.error.message;
    const missingTask = /ENOENT|not found|not recognized/i.test(detail);
    process.stderr.write(
      `check: gate ${target} failed (exit 2)\n` +
        `  cause: ${missingTask ? "task binary not found on PATH (cannot spawn go-task)" : detail}\n` +
        "  remedy: Install go-task (https://taskfile.dev/installation/) and ensure `task` is on PATH; then re-run task check\n",
    );
    return 2;
  }

  if (result.signal === "SIGTERM" && result.status === null && seams.timeoutMs !== undefined) {
    process.stderr.write(
      `check: timed out after ${seams.timeoutMs / 60_000}m (Step 5 vitest coverage budget; #2652)\n`,
    );
    return 124;
  }

  return result.status ?? 1;
}

function defaultSpawn(
  cmd: string,
  args: string[],
  opts: { cwd: string; stdio: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): { status: number | null; signal?: NodeJS.Signals | null; error?: Error } {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd,
    stdio: opts.stdio as "inherit",
    env: opts.env ?? process.env,
    ...(opts.timeoutMs !== undefined
      ? { timeout: opts.timeoutMs, killSignal: "SIGTERM" as const }
      : {}),
  });
  return { status: result.status, signal: result.signal, error: result.error };
}
