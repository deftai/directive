/**
 * `migrate --untrack-core`: the one-time vendored→hybrid `.deft/core` un-commit
 * (#2269). Owns the single destructive `git rm --cached -r .deft/core` index
 * mutation in the framework — `init`/`update` only ever write the
 * non-destructive `.gitignore` entry (boundary asserted by the colocated test).
 *
 * Safety contract:
 *   - NEVER touches working-tree content. `git rm --cached` removes files from
 *     the index only; the on-disk deposit is left intact.
 *   - Gated on a committed `package.json` pin existing (#2264 / Decision 2):
 *     once `.deft/core` is un-committed, content can be reconstituted from the
 *     pinned engine, so nothing is lost. With no pin, un-committing could leave
 *     the deposit unrecoverable, so we refuse.
 *   - Idempotent: once the deposit is un-tracked and ignored, re-running is a
 *     no-op that mutates nothing.
 *
 * The doctor detection that SURFACES this verb (the "payload tracked but should
 * be ignored" signpost emitting `Next command: directive migrate --untrack-core`)
 * is owned by child D (#2267); this module provides only the verb it points at.
 *
 * Refs #2269, #2264, #2123, #2124, #2203.
 */

import { execFileSync } from "node:child_process";
import { PIN_DEPENDENCY_NAME, type PinReadResult, readPin } from "../resolution/pin.js";
import type { InitDepositIo } from "./constants.js";
import {
  ensureUntrackCoreGitignoreLines,
  type GitLsFiles,
  isDepositTrackedInGit,
} from "./gitignore.js";

/** The deposit path un-committed from the git index (never from the working tree). */
export const UNTRACK_CORE_PATH = ".deft/core";

export type UntrackCoreOutcome =
  | "untracked"
  | "already-clean"
  | "refused-missing-pin"
  | "git-error";

export interface UntrackCoreResult {
  readonly outcome: UntrackCoreOutcome;
  /** 0: untracked / already-clean · 1: refused (missing pin) · 2: git error. */
  readonly exitCode: 0 | 1 | 2;
  /** Whether `.deft/core` was tracked in git when the verb ran. */
  readonly deftCoreTracked: boolean;
  /** The committed exact pin version, or null when absent / non-exact. */
  readonly pinVersion: string | null;
  /** Whether the `.gitignore` reconciliation changed the file. */
  readonly gitignoreChanged: boolean;
  readonly message: string;
}

/** Outcome of the injected `git rm --cached -r <paths>` runner. */
export interface GitRmCachedResult {
  readonly ok: boolean;
  /** stdout on success, or the error detail on failure. */
  readonly detail: string;
}

/** Injected git runner for the destructive index mutation (default shells out). */
export type GitRmCached = (projectDir: string, paths: readonly string[]) => GitRmCachedResult;

export interface UntrackCoreSeams {
  /** Probe whether `.deft/core` is git-tracked (default: `git ls-files`). */
  gitLsFiles?: GitLsFiles;
  /** Run `git rm --cached -r <paths>` (default: shells out to git). */
  gitRmCached?: GitRmCached;
  /** Read the committed `package.json` pin (default: resolution/pin.ts readPin). */
  readPin?: (projectRoot: string) => PinReadResult;
  /** Reconcile `.gitignore` (default: ensureUntrackCoreGitignoreLines). */
  ensureGitignore?: (
    projectDir: string,
    io: InitDepositIo,
  ) => { changed: boolean; deftCoreIgnored: boolean };
  /** Output sink for reconciliation messages (default: no-op; the CLI prints the summary). */
  io?: InitDepositIo;
}

/** Default `git rm --cached -r <paths>`: index-only removal, working tree preserved. */
function defaultGitRmCached(projectDir: string, paths: readonly string[]): GitRmCachedResult {
  try {
    const out = execFileSync("git", ["rm", "--cached", "-r", "--", ...paths], {
      cwd: projectDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, detail: out };
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, detail };
  }
}

function refusedMissingPinMessage(pin: PinReadResult): string {
  const reason = pin.nonExact
    ? `package.json pins ${PIN_DEPENDENCY_NAME} with a non-exact range spec (${pin.rawSpec ?? "?"})`
    : `no committed exact package.json pin on ${PIN_DEPENDENCY_NAME} was found`;
  return (
    "directive migrate --untrack-core: refusing to run git rm --cached on .deft/core because " +
    `${reason}. Un-committing without a committed exact pin could leave the deposit content ` +
    "unrecoverable (nothing to reconstitute from). Write and commit an exact pin " +
    "(e.g. via `directive init` / `directive update`), then re-run."
  );
}

/**
 * Orchestrate the vendored→hybrid `.deft/core` un-commit for `projectRoot`.
 * Pure of process exit; the CLI wrapper maps {@link UntrackCoreResult.exitCode}
 * to a process code. Three primary outcomes (untracked / already-clean /
 * refused-missing-pin) plus a git-error fallthrough.
 */
export function untrackCore(projectRoot: string, seams: UntrackCoreSeams = {}): UntrackCoreResult {
  const gitRmCached = seams.gitRmCached ?? defaultGitRmCached;
  const readPinFn = seams.readPin ?? readPin;
  const ensureGitignore = seams.ensureGitignore ?? ensureUntrackCoreGitignoreLines;
  const io: InitDepositIo = seams.io ?? { printf: () => {} };

  const tracked = isDepositTrackedInGit(projectRoot, seams.gitLsFiles);

  // Not tracked (or no git repo / git unavailable): nothing destructive to do.
  // Reconcile the ignore entry so the layout is unambiguous, then report clean.
  if (tracked !== true) {
    const gi = ensureGitignore(projectRoot, io);
    return {
      outcome: "already-clean",
      exitCode: 0,
      deftCoreTracked: false,
      pinVersion: readPinFn(projectRoot).pinVersion,
      gitignoreChanged: gi.changed,
      message:
        `directive migrate --untrack-core: .deft/core is not tracked in git — nothing to ` +
        `un-commit. .gitignore ${gi.changed ? "reconciled (now ignores .deft/core/)" : "already ignores it"}.`,
    };
  }

  // Tracked: gate on the committed pin so content stays reconstitutable.
  // Refuse on either an absent pin OR a non-exact range spec — a range cannot
  // deterministically reconstitute the exact deposit, so it is not a safe gate.
  // The `|| pin.nonExact` makes the invariant self-documenting and robust to any
  // future `readPin` that resolves a version alongside `nonExact: true` (#2269).
  const pin = readPinFn(projectRoot);
  if (pin.pinVersion === null || pin.nonExact) {
    return {
      outcome: "refused-missing-pin",
      exitCode: 1,
      deftCoreTracked: true,
      pinVersion: null,
      gitignoreChanged: false,
      message: refusedMissingPinMessage(pin),
    };
  }

  const rm = gitRmCached(projectRoot, [UNTRACK_CORE_PATH]);
  if (!rm.ok) {
    return {
      outcome: "git-error",
      exitCode: 2,
      deftCoreTracked: true,
      pinVersion: pin.pinVersion,
      gitignoreChanged: false,
      message: `directive migrate --untrack-core: git rm --cached failed: ${rm.detail.trim()}`,
    };
  }

  const gi = ensureGitignore(projectRoot, io);
  return {
    outcome: "untracked",
    exitCode: 0,
    deftCoreTracked: true,
    pinVersion: pin.pinVersion,
    gitignoreChanged: gi.changed,
    message:
      `directive migrate --untrack-core: removed ${UNTRACK_CORE_PATH} from the git index ` +
      `(working tree untouched); pin ${pin.pinVersion} lets \`directive update\` reconstitute ` +
      `content. .gitignore ${gi.changed ? "reconciled (now ignores .deft/core/)" : "already ignores it"}. ` +
      "Commit the removal to complete the un-commit.",
  };
}

export interface RunUntrackCoreCliOptions {
  readonly projectDir: string;
  readonly jsonOut: boolean;
  readonly writeOut: (text: string) => void;
  readonly writeErr: (text: string) => void;
  readonly seams?: UntrackCoreSeams;
}

function buildUntrackCoreSummaryJson(
  result: UntrackCoreResult,
  projectDir: string,
): Record<string, unknown> {
  return {
    success: result.exitCode === 0,
    action: "migrate-untrack-core",
    outcome: result.outcome,
    exit_code: result.exitCode,
    project_dir: projectDir,
    deft_core_tracked: result.deftCoreTracked,
    pin_version: result.pinVersion,
    gitignore_changed: result.gitignoreChanged,
    message: result.message,
  };
}

/**
 * CLI-facing wrapper: runs the un-commit, emits JSON or human output, maps the
 * outcome to a 0/1/2 exit code. Refusals and git errors print to stderr;
 * success prints to stdout.
 */
export function runUntrackCoreCli(options: RunUntrackCoreCliOptions): number {
  const result = untrackCore(options.projectDir, { ...options.seams, io: { printf: () => {} } });

  if (options.jsonOut) {
    options.writeOut(
      `${JSON.stringify(buildUntrackCoreSummaryJson(result, options.projectDir), null, 2)}\n`,
    );
    return result.exitCode;
  }

  if (result.exitCode === 0) {
    options.writeOut(`${result.message}\n`);
  } else {
    options.writeErr(`${result.message}\n`);
  }
  return result.exitCode;
}
