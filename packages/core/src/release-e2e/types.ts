import type { SpawnResult } from "../release/types.js";

export interface E2EConfig {
  owner: string;
  projectRoot: string;
  dryRun: boolean;
  keepRepo: boolean;
  /** When true, skip the npm publish dry-run rehearsal step (#1910). */
  skipNpm: boolean;
  /**
   * When true, run the opt-in pinned legacy->bridge->npm-hybrid migration leg
   * (#1912). Default OFF (optional) so the field is absent on existing callers
   * and the default `task release:e2e` budget is unaffected; mirrors `skipNpm`
   * as an opt-in knob rather than a default-on step.
   */
  legacyBridge?: boolean;
  /** Optional override slug (test injection). If null, a fresh slug is generated per run. */
  repoSlug: string | null;
}

export interface ParsedE2EFlags {
  help: boolean;
  owner: string;
  dryRun: boolean;
  keepRepo: boolean;
  projectRoot: string | null;
  skipNpm: boolean;
  /** Opt-in: run the pinned legacy->bridge->npm-hybrid migration leg (#1912). */
  legacyBridge: boolean;
  unknown: string[];
}

export type EntrypointFn = (argv: string[]) => number;

export interface E2ESeams {
  whichGh?: (name: string) => string | null;
  /** Generic PATH lookup for the npm publish dry-run rehearsal (#1910). */
  which?: (name: string) => string | null;
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
