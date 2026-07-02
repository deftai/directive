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
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";

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
 * True when `path` is the directive framework source checkout root (not a
 * vendored `.deft/core` content deposit). Used to distinguish a maintainer
 * running `task check` from a subdirectory (#2220) from a consumer install.
 */
export function isFrameworkRepoRoot(path: string): boolean {
  const root = resolve(path);
  return (
    existsSync(join(root, "packages", "cli", "package.json")) &&
    existsSync(join(root, "biome.json")) &&
    existsSync(join(root, "Taskfile.yml"))
  );
}

/**
 * Return true when running in the framework's own source checkout (#1519).
 *
 * Mirrors `is_framework_source_context` from _project_context.py with one
 * extension (#2220): when the Taskfile lives at the framework repo root,
 * `task check` may be invoked from a subdirectory (`USER_WORKING_DIR` !=
 * `TASKFILE_DIR`). Those invocations must still route to
 * `check:framework-source` so the biome lane runs. We do NOT resolve
 * symlinks on the framework root -- a consumer project may symlink
 * `.deft/core` to a local framework checkout and should still run the
 * consumer-safe gate (the deposit path lacks `packages/cli`).
 */
export function isFrameworkSourceContext(frameworkRoot: string, projectRoot: string): boolean {
  const fw = resolve(frameworkRoot);
  const pr = resolve(projectRoot);
  if (fw === pr) {
    return true;
  }
  if (!isFrameworkRepoRoot(fw)) {
    return false;
  }
  return pr.startsWith(`${fw}${sep}`);
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
