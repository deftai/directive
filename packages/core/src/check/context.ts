import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export interface CheckOrchestratorOptions {
  readonly noCache?: boolean;
  readonly useTaskCache?: boolean;
}

export interface CheckOrchestratorSeams extends CheckOrchestratorOptions {
  /** Override the `task` binary path (default: "task"). */
  readonly taskBin?: string;
  /** Override the spawnSync implementation for unit testing. */
  readonly spawnFn?: (
    cmd: string,
    args: string[],
    opts: { cwd: string; stdio: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
  ) => { status: number | null; signal?: NodeJS.Signals | null; error?: Error };
  /** Child-process environment (default: process.env). */
  readonly env?: NodeJS.ProcessEnv;
  /** Wall-clock spawn timeout in milliseconds (default: none). */
  readonly timeoutMs?: number;
}

/** True when `path` is the directive framework source checkout root. */
export function isFrameworkRepoRoot(path: string): boolean {
  const root = resolve(path);
  return (
    existsSync(join(root, "packages", "cli", "package.json")) &&
    existsSync(join(root, "biome.json")) &&
    existsSync(join(root, "Taskfile.yml"))
  );
}

/** Return true when running in the framework's own source checkout (#1519). */
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

/** Select the Taskfile target for the given context. */
export function resolveCheckTarget(frameworkRoot: string, projectRoot: string): string {
  return isFrameworkSourceContext(frameworkRoot, projectRoot)
    ? "check:framework-source"
    : "check:consumer";
}
