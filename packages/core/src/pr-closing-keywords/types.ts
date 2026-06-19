export interface Hit {
  readonly source: string;
  readonly keyword: string;
  readonly issueNumber: number;
  readonly context: string;
  readonly reason: string;
}

export interface RunGhResult {
  readonly returncode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Injectable gh subprocess seam (#1366 / parity harness). */
export type RunGhFn = (cmd: readonly string[]) => RunGhResult;

export interface ParsedArgs {
  readonly pr: number | null;
  readonly bodyFile: string | null;
  readonly commitsFile: string | null;
  readonly repo: string | null;
  readonly allowKnownFalsePositives: readonly string[];
  readonly error?: string;
}
