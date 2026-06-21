/**
 * check/orchestrator.ts -- Context-aware `task check` orchestrator (#1854).
 *
 * TypeScript port of scripts/_project_context.py dispatch_task_check().
 * Detects whether we are running in the framework-source context or a
 * vendored-consumer context (#1519) and dispatches to the appropriate
 * aggregate Taskfile target.
 *
 * Exit codes (three-state, mirrors _project_context.py):
 *   0 -- all gates passed
 *   1 -- one or more gates failed
 *   2 -- config error (missing args, task spawn error, etc.)
 */

import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

/** Seams for test isolation (allow injecting a custom task runner). */
export interface CheckOrchestratorSeams {
  /** Override the `task` binary path (default: "task"). */
  readonly taskBin?: string;
  /** Override the spawnSync implementation for unit testing. */
  readonly spawnFn?: (
    cmd: string,
    args: string[],
    opts: { cwd: string; stdio: string },
  ) => { status: number | null; error?: Error };
}

/**
 * Return true when running in the framework's own source checkout (#1519).
 *
 * Mirrors `is_framework_source_context` from _project_context.py:
 * equality of lexical absolute roots is the stable distinction. We do NOT
 * resolve symlinks here -- a consumer project may symlink `.deft/core` to a
 * local framework checkout and should still run the consumer-safe gate.
 */
export function isFrameworkSourceContext(frameworkRoot: string, projectRoot: string): boolean {
  return resolve(frameworkRoot) === resolve(projectRoot);
}

/**
 * Select the Taskfile target for the given context.
 *
 * Mirrors _project_context.py::dispatch_task_check target selection.
 */
export function resolveCheckTarget(frameworkRoot: string, projectRoot: string): string {
  return isFrameworkSourceContext(frameworkRoot, projectRoot)
    ? "check:framework-source"
    : "check:consumer";
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
  const taskfilePath = join(resolvedFramework, "Taskfile.yml");
  const taskBin = seams.taskBin ?? "task";

  const target = resolveCheckTarget(resolvedFramework, resolvedProject);
  const cwd = target === "check:framework-source" ? resolvedFramework : resolvedProject;

  const spawn = seams.spawnFn ?? defaultSpawn;
  const result = spawn(taskBin, [target, "--taskfile", taskfilePath], {
    cwd,
    stdio: "inherit",
  });

  if (result.error !== undefined) {
    process.stderr.write(`check: failed to invoke task: ${result.error.message}\n`);
    return 2;
  }

  return result.status ?? 1;
}

function defaultSpawn(
  cmd: string,
  args: string[],
  opts: { cwd: string; stdio: string },
): { status: number | null; error?: Error } {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd,
    stdio: opts.stdio as "inherit",
    env: { ...process.env },
  });
  return { status: result.status, error: result.error };
}
