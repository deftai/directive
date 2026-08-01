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

/** Lint mode for closing-keyword checks (#3015). */
export type ClosingKeywordMode = "fp" | "intent" | "both";

export interface ParsedArgs {
  readonly pr: number | null;
  readonly bodyFile: string | null;
  readonly commitsFile: string | null;
  readonly repo: string | null;
  readonly allowKnownFalsePositives: readonly string[];
  /** Intent-mode allowlist of issue numbers permitted to use real closing keywords (#3015). */
  readonly allowClose: readonly string[];
  /**
   * fp = Layer 0 #737 (negation/quote/example/code only);
   * intent = any closing keyword unless allowlisted (#3015 class D);
   * both = default (FP + intent).
   */
  readonly mode: ClosingKeywordMode;
  readonly error?: string;
}
