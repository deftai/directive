/** Internal gate/task contract (#1713). Public promotion deferred to #2784. */

export interface TaskInputSpec {
  /** Glob patterns relative to the project root. */
  readonly globs?: readonly string[];
  /** Environment variable names whose values affect the task outcome. */
  readonly env?: readonly string[];
}

export interface TaskContract {
  readonly id: string;
  /** When false the task always runs and never stores a cache entry. */
  readonly cacheable: boolean;
  /** Override engine version in the cache key; defaults to installed directive version. */
  readonly codeVersion?: string;
  readonly inputs: TaskInputSpec;
  /** Output globs for under-declaration lint (optional). */
  readonly outputs?: readonly string[];
  /** Superset of reads used by under-declaration lint. */
  readonly knownReadSet?: TaskInputSpec;
}

export interface TaskRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly fromCache: boolean;
}

export interface CachedTaskRecord {
  readonly taskId: string;
  readonly inputsHash: string;
  readonly codeVersion: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly storedAt: string;
}

export interface RunWithCacheOptions {
  readonly projectRoot: string;
  readonly contract: TaskContract;
  readonly codeVersion: string;
  readonly noCache?: boolean;
  readonly cacheRoot?: string;
  readonly runner: () => Pick<TaskRunResult, "exitCode" | "stdout" | "stderr">;
}

export interface RegistryLintFinding {
  readonly taskId: string;
  readonly kind: "under-declared-input" | "non-cacheable";
  readonly detail: string;
}
