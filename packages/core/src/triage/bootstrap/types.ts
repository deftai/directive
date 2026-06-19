/** Per-step result captured by the bootstrap dispatcher. */
export interface StepOutcome {
  readonly name: string;
  readonly ok: boolean;
  readonly message: string;
  readonly error?: string | null;
  readonly details: Record<string, unknown>;
}

/** Aggregate result returned by {@link runBootstrap}. */
export interface BootstrapResult {
  readonly projectRoot: string;
  readonly repo: string | null;
  readonly steps: StepOutcome[];
  readonly exitCode: number;
}

/** Report shape returned by cache_fetch_all (Python or injectable stub). */
export interface FetchAllReport {
  readonly succeeded?: number | null;
  readonly failed?: number | null;
  readonly skipped?: number | null;
  readonly summaryLine?: ((source: string, repo: string) => string) | null;
}

/** Injectable cache module for tests and optional Python bridge. */
export interface CacheModule {
  cacheFetchAll(kwargs: CacheFetchAllKwargs): FetchAllReport | Promise<FetchAllReport>;
}

export interface CacheFetchAllKwargs {
  readonly source: string;
  readonly repo: string;
  readonly cacheRoot: string;
  readonly batchSize?: number;
  readonly delayMs?: number;
  readonly state?: string;
  readonly limit?: number;
  readonly labels?: readonly string[];
  readonly author?: string;
}

export type ProgressWriter = ((line: string) => void) | null;

export interface RunBootstrapOptions {
  readonly cacheModule?: CacheModule | null;
  readonly batchSize?: number;
  readonly delayMs?: number;
  readonly state?: string;
  readonly limit?: number;
  readonly labels?: readonly string[];
  readonly author?: string;
  readonly fetchTimeoutS?: number | null;
  readonly progress?: ProgressWriter | typeof PROGRESS_DEFAULT;
  readonly inferRepoFromGit?: (cwd: string) => string | null;
  readonly nowIso?: () => string;
  readonly runWithTimeout?: <T>(
    func: () => T | Promise<T>,
    timeoutS: number,
  ) => Promise<{ completed: boolean; result: T | null; error: Error | null }>;
  readonly appendAuditEntry?: (auditPath: string, entry: Record<string, unknown>) => void;
  readonly deftRoot?: string;
}

export const PROGRESS_DEFAULT: unique symbol = Symbol("progress-default");
