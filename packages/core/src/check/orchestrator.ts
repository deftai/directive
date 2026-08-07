/**
 * check/orchestrator.ts -- Context-aware `task check` orchestrator (#1854).
 *
 * TypeScript port of scripts/_project_context.py dispatch_task_check().
 * Detects whether we are running in the framework-source context or a
 * vendored-consumer context (#1519) and dispatches to the appropriate
 * aggregate Taskfile target.
 *
 * Default path uses the cached sequential gate runner (#1713) with
 * fast-before-slow ordering (#3188): cheap gates run before `ts:check-lane`
 * (vitest+coverage). A fast-gate failure aborts before the suite starts.
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
import { type CheckOrchestratorSeams, resolveCheckTarget } from "./context.js";

export type { CheckOrchestratorOptions, CheckOrchestratorSeams } from "./context.js";
export { isFrameworkRepoRoot, isFrameworkSourceContext, resolveCheckTarget } from "./context.js";

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

  const spawn = seams.spawnFn ?? defaultSpawn;
  const result = spawn(taskBin, [target, "--taskfile", taskfilePath], {
    cwd,
    stdio: "inherit",
    env: seams.env,
    timeoutMs: seams.timeoutMs,
  });

  if (result.error !== undefined) {
    process.stderr.write(`check: failed to invoke task: ${result.error.message}\n`);
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
