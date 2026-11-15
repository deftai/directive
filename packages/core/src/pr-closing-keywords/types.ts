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
  /** Offline `--body-file` step: append the story line for the branch's running story (#6316). */
  readonly writeStoryLine: boolean;
  /** With `writeStoryLine`: write `deft-story-part: N` instead of `deft-story: N` (#6316). */
  readonly part: boolean;
  readonly error?: string;
}

/**
 * One file read at a fixed git ref (merge base) for part-line admission (#6316).
 * `absent` means the path did not exist at that ref; `error` fails closed.
 */
export type RefFileRead =
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "absent" }
  | { readonly kind: "error"; readonly detail: string };

/** Reads a repo-relative path at the PR merge base (#6316). */
export type ReadMergeBaseFileFn = (path: string) => RefFileRead;

/** Result of `--write-story-line` on a PR body file (#6316). */
export interface WriteStoryLineResult {
  /** 0 written or nothing to write / 1 both lines for one N / 2 config or read error. */
  readonly code: 0 | 1 | 2;
  readonly message: string;
  /** Running-story issues found for the branch. */
  readonly issues: readonly number[];
  /** Lines appended to the body file. */
  readonly written: readonly string[];
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
