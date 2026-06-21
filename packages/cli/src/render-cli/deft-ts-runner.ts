import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root (four levels up from packages/cli/src/render-cli). */
export function resolveRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

/** Built deft-ts dispatcher entrypoint. */
export function resolveBinPath(): string {
  return resolve(resolveRepoRoot(), "packages/cli/dist/bin.js");
}

export interface DeftTsResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Invoke `node packages/cli/dist/bin.js [...argv]` and capture output. */
export function runDeftTsArgv(
  argv: readonly string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): DeftTsResult {
  const bin = resolveBinPath();
  const result = spawnSync(process.execPath, [bin, ...argv], {
    cwd: options.cwd ?? resolveRepoRoot(),
    encoding: "utf8",
    env: {
      ...process.env,
      DEFT_CACHE_DISABLE: "1",
      PYTHONUTF8: "1",
      ...options.env,
    },
  });
  return {
    exitCode: result.status ?? 2,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Invoke `node packages/cli/dist/bin.js <verb> [...args]` and capture output. */
export function runDeftTs(
  verb: string,
  args: readonly string[] = [],
  options: { cwd?: string; env?: Record<string, string> } = {},
): DeftTsResult {
  return runDeftTsArgv([verb, ...args], options);
}
