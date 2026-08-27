export interface WaitMergeableResult {
  readonly prNumber: number;
  readonly repo: string | null;
  readonly outcome: string;
  readonly exitCode: number;
  readonly monitorResult: Record<string, unknown>;
  readonly protectedCheck: Record<string, unknown>;
  readonly semanticGreen: Record<string, unknown>;
  readonly mergeStdout: string;
  readonly mergeStderr: string;
  readonly error: string | null;
}

export type SubprocessTriple = readonly [number, string, string];

export type ProtectedCheckFn = (
  prNumber: number,
  repo: string | null,
  protectedIssues: readonly number[],
) => SubprocessTriple;

export type MonitorFn = (
  prNumber: number,
  repo: string,
  capMinutes: number,
  options?: { readonly projectRoot?: string },
) => SubprocessTriple;

export type MergeFn = (
  prNumber: number,
  repo: string | null,
  options?: { readonly matchHeadCommit?: string | null },
) => SubprocessTriple;

/** Merge-time closeout attestability gate (#3781): 0 attestable / 1 unattested / 2 lookup. */
export type CloseoutAttestableFn = (
  prNumber: number,
  repo: string | null,
  projectRoot: string,
) => SubprocessTriple;
