import type { SpawnResult } from "../release/types.js";

export interface E2EConfig {
  owner: string;
  projectRoot: string;
  dryRun: boolean;
  keepRepo: boolean;
  /** Optional override slug (test injection). If null, a fresh slug is generated per run. */
  repoSlug: string | null;
}

export interface ParsedE2EFlags {
  help: boolean;
  owner: string;
  dryRun: boolean;
  keepRepo: boolean;
  projectRoot: string | null;
  unknown: string[];
}

export type EntrypointFn = (argv: string[]) => number;

export interface E2ESeams {
  whichGh?: (name: string) => string | null;
  spawnText?: (
    cmd: string,
    args: readonly string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
  ) => SpawnResult;
  runGit?: (projectRoot: string, args: readonly string[], env?: NodeJS.ProcessEnv) => SpawnResult;
  mkdtemp?: (prefix: string) => string;
  rmTemp?: (path: string) => void;
  generateRepoSlug?: () => string;
  releaseEntrypoint?: EntrypointFn;
  rollbackEntrypoint?: EntrypointFn;
  now?: () => Date;
  randomUuidHex?: () => string;
}
