export interface GreptileVerdict {
  readonly found: boolean;
  readonly errored: boolean;
  readonly lastReviewedSha: string | null;
  readonly confidence: number | null;
  readonly p0Count: number;
  readonly p1Count: number;
  readonly p2Count: number;
  readonly informalClean: boolean;
  readonly rawBodyExcerpt: string;
}

export interface GateResult {
  readonly prNumber: number;
  readonly repo: string | null;
  readonly headSha: string | null;
  readonly verdict: GreptileVerdict;
  readonly failures: readonly string[];
  readonly via: string;
  readonly partialData: Readonly<Record<string, unknown>>;
  readonly error: string | null;
}

export interface RunGhResult {
  readonly returncode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Injectable gh subprocess seam (#1366 / parity harness). */
export type RunGhFn = (cmd: readonly string[]) => RunGhResult;
