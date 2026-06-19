export interface RunGhResult {
  readonly returncode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Injectable gh capture seam for tests and parity harnesses. */
export type RunGhFn = (cmd: readonly string[]) => RunGhResult;
