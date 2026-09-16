import {
  binPath,
  type DeftTsResult,
  type RunDeftTsOptions,
  repoRoot,
  runDeftTsArgv as runDeftTsArgvInProcess,
  runDeftTs as runDeftTsInProcess,
} from "../gates-cli/_helpers.js";

export type { DeftTsResult, RunDeftTsOptions };

/** Repo root (four levels up from packages/cli/src/render-cli). */
export function resolveRepoRoot(): string {
  return repoRoot();
}

/** Built deft-ts dispatcher entrypoint. Spawn leftovers still resolve this path. */
export function resolveBinPath(): string {
  return binPath();
}

/** Invoke `directive [...argv]` in-process (#4591). */
export async function runDeftTsArgv(
  argv: readonly string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<DeftTsResult> {
  const opts: RunDeftTsOptions = { cwd: options.cwd, env: options.env };
  return runDeftTsArgvInProcess(argv, opts);
}

/** Invoke `directive <verb> [...args]` in-process (#4591). */
export async function runDeftTs(
  verb: string,
  args: readonly string[] = [],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<DeftTsResult> {
  return runDeftTsInProcess(verb, args, { cwd: options.cwd, env: options.env });
}
