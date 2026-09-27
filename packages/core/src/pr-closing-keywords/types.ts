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
  /** Offline git range (e.g. origin/master..HEAD) for check-graph wiring (#3969). */
  readonly fromGitRange: string | null;
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
  /** Distinct one-PR-unit grant id (#4494). Not `--allow-close`. */
  readonly onePrUnit: string | null;
  readonly projectRoot: string | null;
  readonly error?: string;
}

/**
 * Full-story close intent recorded at PR open (#4864).
 * Body line `deft-story: N` (digits only). Not `--allow-close` and not Closes/Fixes/Resolves.
 * Finalize consumes this after leftover-complete; `deft-close-intent: full` stays unauthorized.
 */
export interface FullStoryCloseIntent {
  readonly issue: number;
  readonly source: "deft-story";
}
