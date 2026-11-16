/**
 * Git runner for verify:scope-provenance (#6378).
 *
 * Every git call of the check goes through one runner:
 * - `spawnSync` with the `timeout` option and `killSignal: "SIGKILL"`. At the
 *   limit the operating system ends the git process (git cannot handle or
 *   ignore SIGKILL; on Windows Node ends the process unconditionally).
 *   `spawnSync` returns when that process has exited, and only then does the
 *   runner act on the result. No JavaScript timer is involved. The limit ends
 *   the git process the check started, not a helper process that git started.
 * - `GIT_OPTIONAL_LOCKS=0`, so a call ended at the limit leaves no optional
 *   index lock behind.
 * - the existing subprocess buffer limit.
 *
 * A call that reaches the limit is its own error kind. Under the declared
 * refusal row below in `warn` mode the runner writes one line and runs the
 * same command once more with no limit. In `enforce` mode it throws
 * {@link GitCallTimeoutError}; the evaluator turns that into exit 2.
 */

import { type SpawnSyncOptions, type SpawnSyncReturns, spawnSync } from "node:child_process";
import { writeSync } from "node:fs";
import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";

export type DeclaredRefusalMode = "warn" | "enforce";

/** One declared refusal, in the field shape of the #6281 declaration table. */
export interface DeclaredRefusalRow {
  readonly id: string;
  readonly mode: DeclaredRefusalMode;
  readonly reason: string;
  readonly remedy: string;
}

/**
 * Declared refusal for the per-call git time limit (#6378 item 10).
 *
 * The #6281 declaration table does not exist yet, so the row is a constant
 * here; it moves to that table when the table exists. It ships in `warn`
 * mode. The change to `enforce` is a later one-line change of `mode` with its
 * own changelog entry.
 */
export const SCOPE_PROVENANCE_GIT_CALL_TIMEOUT: DeclaredRefusalRow = {
  id: "scope-provenance-git-call-timeout",
  mode: "warn",
  reason:
    "A git call of verify:scope-provenance ran past its per-call time limit; no other " +
    "control ends or names a blocked git call in this check.",
  remedy: "Run the verb again with a larger --git-timeout-seconds value.",
};

/** Default per-call limit in seconds (#6378 item 8). A policy value, not a proof. */
export const DEFAULT_GIT_TIMEOUT_SECONDS = 120;

/** Environment override for runs that cannot pass `--git-timeout-seconds`. */
export const GIT_TIMEOUT_ENV = "DEFT_SCOPE_PROVENANCE_GIT_TIMEOUT_SECONDS";

/** Largest accepted value (about 11.5 days); larger input is not a number of seconds we accept. */
const MAX_GIT_TIMEOUT_SECONDS = 1_000_000;

/** Parse a whole number of seconds (`0` means no limit). Null when the text is not one. */
export function parseGitTimeoutSeconds(raw: string): number | null {
  const t = raw.trim();
  if (!/^[0-9]{1,7}$/.test(t)) return null;
  const n = Number(t);
  return n <= MAX_GIT_TIMEOUT_SECONDS ? n : null;
}

/**
 * Per-call limit: the flag wins, then a valid environment value, then the
 * default. An environment value that is not a whole number is ignored.
 */
export function resolveGitTimeoutSeconds(
  flag: number | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (flag !== null && flag !== undefined) return flag;
  const fromEnv = parseGitTimeoutSeconds(env[GIT_TIMEOUT_ENV] ?? "");
  return fromEnv ?? DEFAULT_GIT_TIMEOUT_SECONDS;
}

/** A larger limit for the remedy line. */
export function largerGitTimeoutSeconds(limitSeconds: number): number {
  return Math.min(MAX_GIT_TIMEOUT_SECONDS, Math.max(limitSeconds * 2, limitSeconds + 60));
}

/** Default remedy text: the verb with a larger `--git-timeout-seconds` value. */
export function defaultGitTimeoutRemedy(largerSeconds: number): string {
  return `deft verify:scope-provenance --git-timeout-seconds ${String(largerSeconds)}`;
}

export type ScopeProvenancePhase =
  | "base resolution"
  | "change-set read"
  | "census"
  | "per-story evaluation";

/** `git <args>` as one readable command string. */
export function formatGitCommand(args: readonly string[]): string {
  return ["git", ...args]
    .map((a) => (/^[\w./:@=+,^~-]+$/.test(a) ? a : JSON.stringify(a)))
    .join(" ");
}

export interface GitCallTimeoutLineInput {
  readonly mode: DeclaredRefusalMode;
  readonly phase: ScopeProvenancePhase;
  readonly command: string;
  readonly elapsedSeconds: number;
  readonly limitSeconds: number;
  readonly remedy: string;
}

/** The one line for a call that reached the limit (warn line or enforce refusal). */
export function formatGitCallTimeoutLine(input: GitCallTimeoutLineInput): string {
  const row = SCOPE_PROVENANCE_GIT_CALL_TIMEOUT;
  const head =
    `verify_scope_provenance: ${row.id} (${input.mode}): \`${input.command}\` reached the ` +
    `${String(input.limitSeconds)} s per-call limit in phase "${input.phase}" after ` +
    `${input.elapsedSeconds.toFixed(1)} s and was ended.`;
  if (input.mode === "warn") {
    return (
      `${head} It runs once more with no limit; this check can refuse (exit 2) from a later ` +
      `release. Remedy: ${input.remedy}`
    );
  }
  return `${head} Refused (exit 2). Remedy: ${input.remedy}`;
}

/** A git call that reached the per-call limit in `enforce` mode. */
export class GitCallTimeoutError extends Error {
  readonly id = SCOPE_PROVENANCE_GIT_CALL_TIMEOUT.id;
  constructor(
    message: string,
    readonly phase: ScopeProvenancePhase,
    readonly command: string,
    readonly elapsedSeconds: number,
    readonly limitSeconds: number,
  ) {
    super(message);
    this.name = "GitCallTimeoutError";
  }
}

/** spawnSync-shaped seam (tests replace it). */
export type GitSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions,
) => SpawnSyncReturns<string | Buffer>;

export interface ScopeProvenanceGitOptions {
  /** Per-call limit in seconds; `0` means no limit. Absent: env, then 120. */
  readonly timeoutSeconds?: number;
  /** Mode override (tests). Absent: the declared row's mode. */
  readonly mode?: DeclaredRefusalMode;
  /** Sink for the warn line. Absent: a synchronous write to fd 2. */
  readonly report?: (line: string) => void;
  /** Remedy text for a larger limit. Absent: {@link defaultGitTimeoutRemedy}. */
  readonly remedy?: (largerSeconds: number) => string;
  /** spawnSync seam (tests). */
  readonly spawn?: GitSpawn;
  /** Subprocess buffer limit (tests). Absent: the shared 64 MiB limit. */
  readonly maxBuffer?: number;
  /** Base environment. Absent: `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

export interface ScopeProvenanceGit {
  /** Per-call limit in seconds (`0` = none). */
  readonly timeoutSeconds: number;
  /** Subprocess buffer limit for every call. */
  readonly maxBuffer: number;
  /** Phase named by a timeout line. */
  phase(): ScopeProvenancePhase;
  /** Set the phase; returns the previous one. */
  setPhase(phase: ScopeProvenancePhase): ScopeProvenancePhase;
  /** Run `git <args>` in `cwd`, stdout decoded as UTF-8. */
  runText(args: readonly string[], cwd: string, input?: string): SpawnSyncReturns<string>;
  /** Run `git <args>` in `cwd` with `input` on stdin, stdout as bytes. */
  runBytes(args: readonly string[], cwd: string, input: string): SpawnSyncReturns<Buffer>;
  /** First enforce-mode timeout, kept even when a caller swallowed the throw. */
  timedOut(): GitCallTimeoutError | null;
}

/** True when `spawnSync` ended the call at its `timeout`. */
export function isGitCallTimeout(result: { readonly error?: Error }): boolean {
  return (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
}

function writeLineToFd2(line: string): void {
  try {
    writeSync(2, `${line}\n`);
  } catch {
    // stderr closed: the line is diagnostics only.
  }
}

export function createScopeProvenanceGit(
  options: ScopeProvenanceGitOptions = {},
): ScopeProvenanceGit {
  const baseEnv = options.env ?? process.env;
  const timeoutSeconds = options.timeoutSeconds ?? resolveGitTimeoutSeconds(undefined, baseEnv);
  const mode = options.mode ?? SCOPE_PROVENANCE_GIT_CALL_TIMEOUT.mode;
  const report = options.report ?? writeLineToFd2;
  const remedy = options.remedy ?? defaultGitTimeoutRemedy;
  const spawn: GitSpawn = options.spawn ?? (spawnSync as GitSpawn);
  const maxBuffer = options.maxBuffer ?? SUBPROCESS_MAX_BUFFER;
  // Read the environment per call so a long-lived runner sees later changes.
  const callEnv = (): NodeJS.ProcessEnv => ({
    ...(options.env ?? process.env),
    GIT_OPTIONAL_LOCKS: "0",
  });
  let currentPhase: ScopeProvenancePhase = "base resolution";
  let latched: GitCallTimeoutError | null = null;

  const spawnOnce = (
    args: readonly string[],
    cwd: string,
    input: string | undefined,
    encoding: "utf8" | "buffer",
    limitSeconds: number,
  ): SpawnSyncReturns<string | Buffer> =>
    spawn("git", args, {
      cwd,
      encoding,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      maxBuffer,
      env: callEnv(),
      // A Buffer, because Node encodes a string input with `encoding` ("buffer" is not one).
      ...(input !== undefined ? { input: Buffer.from(input, "utf8") } : {}),
      ...(limitSeconds > 0 ? { timeout: limitSeconds * 1000, killSignal: "SIGKILL" as const } : {}),
    });

  const run = (
    args: readonly string[],
    cwd: string,
    input: string | undefined,
    encoding: "utf8" | "buffer",
  ): SpawnSyncReturns<string | Buffer> => {
    const started = Date.now();
    const first = spawnOnce(args, cwd, input, encoding, timeoutSeconds);
    if (timeoutSeconds === 0 || !isGitCallTimeout(first)) return first;
    // spawnSync has returned: the git process has exited. Act on it now.
    const elapsedSeconds = (Date.now() - started) / 1000;
    const command = formatGitCommand(args);
    const line = formatGitCallTimeoutLine({
      mode,
      phase: currentPhase,
      command,
      elapsedSeconds,
      limitSeconds: timeoutSeconds,
      remedy: remedy(largerGitTimeoutSeconds(timeoutSeconds)),
    });
    if (mode === "enforce") {
      const err = new GitCallTimeoutError(
        line,
        currentPhase,
        command,
        elapsedSeconds,
        timeoutSeconds,
      );
      latched ??= err;
      throw err;
    }
    report(line);
    return spawnOnce(args, cwd, input, encoding, 0);
  };

  return {
    timeoutSeconds,
    maxBuffer,
    phase: () => currentPhase,
    setPhase: (phase) => {
      const previous = currentPhase;
      currentPhase = phase;
      return previous;
    },
    runText: (args, cwd, input) => run(args, cwd, input, "utf8") as SpawnSyncReturns<string>,
    runBytes: (args, cwd, input) => run(args, cwd, input, "buffer") as SpawnSyncReturns<Buffer>,
    timedOut: () => latched,
  };
}
