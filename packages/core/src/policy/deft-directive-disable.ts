/**
 * Temporary test/local kill-switch for Directive enforcement (#3039).
 *
 * Presence of root `.deft-directive-disable` means Directive **enforcement** is
 * OFF (hooks, session ritual, automation) while the deposit may remain.
 * Distinct from `.no-deft-directive` (#2926 permanent opt-out): flag+deposit is
 * **not** inconsistent here.
 *
 * Product choices (v1):
 * - Flag is **root-only** (workspace root the tool opened).
 * - Flag **must be gitignored** (canonical baseline); committed flag → doctor warns.
 * - Deposit presence is **OK**.
 * - Full re-enable requires: delete the file **and** start a **new** agent session.
 * - Precedence: this flag first, then `.no-deft-directive`, else normal Directive.
 */

import { execFileSync } from "node:child_process";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { assertWriteTargetSafe } from "../fs/projection-containment.js";
import { CANONICAL_INSTALL_ROOT } from "../init-deposit/constants.js";

/** Canonical root-only filename (lowercase). Presence = flag. */
export const DEFT_DIRECTIVE_DISABLE_FLAG_NAME = ".deft-directive-disable";

/** Gitignore entry the deposit must ensure (same as flag name). */
export const DEFT_DIRECTIVE_DISABLE_GITIGNORE_LINE = DEFT_DIRECTIVE_DISABLE_FLAG_NAME;

/**
 * Canonical recovery message when Directive is disabled by the test kill-switch.
 * Surfaces (doctor, agent, CLI, hooks) share this wording.
 */
export const DEFT_DIRECTIVE_DISABLE_RECOVERY_MESSAGE =
  "Directive is DISABLED for this project via root `.deft-directive-disable` (test/local kill-switch).\n" +
  "Deposit may still be present; enforcement (hooks, session ritual, automation) will not run.\n" +
  "\n" +
  "To fully re-enable Directive:\n" +
  "  1. Delete the file:  rm .deft-directive-disable   (or equivalent)\n" +
  "  2. Start a NEW agent session (reload AGENTS / host skills / hooks)\n" +
  "Until both are done, Directive is not fully operational.";

/** One-line summary for log lines and short CLI output. */
export const DEFT_DIRECTIVE_DISABLE_ONE_LINE =
  "Directive disabled via `.deft-directive-disable` (test/local kill-switch; deposit OK)";

/** Doctor/status label when the kill-switch is active. */
export const DEFT_DIRECTIVE_DISABLE_STATUS = "disabled-test-kill-switch" as const;

/**
 * Warning when the kill-switch file is tracked by git (should be gitignored).
 */
export const DEFT_DIRECTIVE_DISABLE_TRACKED_WARNING =
  "Misconfig: `.deft-directive-disable` is tracked by git. The flag must be gitignored (local kill-switch only). Untrack it and ensure `.gitignore` covers the path.";

export interface DeftDirectiveDisableSeams {
  readonly isFile?: (path: string) => boolean;
  readonly isDir?: (path: string) => boolean;
  /** Return true when `git ls-files` lists the flag (tracked). */
  readonly isGitTracked?: (projectRoot: string, relPath: string) => boolean;
}

export interface DeftDirectiveDisableState {
  readonly present: boolean;
  readonly flagPath: string;
  readonly depositPresent: boolean;
  /**
   * True when the flag file is tracked by git (misconfig — should be gitignored).
   * Always false when the flag is absent or when the probe cannot run.
   */
  readonly trackedByGit: boolean;
}

function defaultIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function defaultIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function defaultIsGitTracked(projectRoot: string, relPath: string): boolean {
  try {
    const out = execFileSync("git", ["ls-files", "--", relPath], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/** Absolute path to the root kill-switch flag file. */
export function deftDirectiveDisableFlagPath(projectRoot: string): string {
  return resolve(projectRoot, DEFT_DIRECTIVE_DISABLE_FLAG_NAME);
}

/**
 * Detect root `.deft-directive-disable`. Presence is file-existence only
 * (empty or short comment OK). Deposit presence is reported but never treated
 * as inconsistent (#3039 vs #2926).
 */
export function detectDeftDirectiveDisable(
  projectRoot: string,
  seams: DeftDirectiveDisableSeams = {},
): DeftDirectiveDisableState {
  const flagPath = deftDirectiveDisableFlagPath(projectRoot);
  const isFile = seams.isFile ?? defaultIsFile;
  const isDir = seams.isDir ?? defaultIsDir;
  const isGitTracked = seams.isGitTracked ?? defaultIsGitTracked;
  const present = isFile(flagPath);
  const depositPresent = isDir(join(projectRoot, CANONICAL_INSTALL_ROOT));
  const trackedByGit = present
    ? isGitTracked(projectRoot, DEFT_DIRECTIVE_DISABLE_FLAG_NAME)
    : false;
  return {
    present,
    flagPath,
    depositPresent,
    trackedByGit,
  };
}

/** True when the root test kill-switch flag file exists. */
export function isDeftDirectiveDisablePresent(
  projectRoot: string,
  seams: DeftDirectiveDisableSeams = {},
): boolean {
  return detectDeftDirectiveDisable(projectRoot, seams).present;
}

/**
 * Full operator-facing message for the kill-switch, optionally combined with
 * permanent opt-out when both flags are present.
 */
export function formatDeftDirectiveDisableMessage(
  options: {
    readonly permanentOptOutAlsoPresent?: boolean;
    readonly trackedByGit?: boolean;
    readonly oneLine?: boolean;
  } = {},
): string {
  const parts: string[] = [];
  if (options.oneLine) {
    parts.push(DEFT_DIRECTIVE_DISABLE_ONE_LINE);
  } else {
    parts.push(DEFT_DIRECTIVE_DISABLE_RECOVERY_MESSAGE);
  }
  if (options.permanentOptOutAlsoPresent) {
    parts.push(
      "Also present: root `.no-deft-directive` (permanent opt-out). Install/update fail-closed semantics still apply for that flag.",
    );
  }
  if (options.trackedByGit) {
    parts.push(DEFT_DIRECTIVE_DISABLE_TRACKED_WARNING);
  }
  return parts.join("\n\n");
}

/**
 * Create the root kill-switch flag. Optional one-line rationale becomes a `#` comment.
 * Does not remove an existing deposit.
 */
export function createDeftDirectiveDisableFlag(
  projectRoot: string,
  options: { rationale?: string } = {},
): string {
  const path = deftDirectiveDisableFlagPath(projectRoot);
  if (defaultIsDir(path)) {
    throw new Error(
      `${DEFT_DIRECTIVE_DISABLE_FLAG_NAME} exists as a directory at ${path}; remove it before creating the kill-switch flag file.`,
    );
  }
  const rationale = options.rationale?.trim() ?? "";
  const body = rationale.length > 0 ? `# ${rationale}\n` : "";
  containedWrite({
    root: resolve(projectRoot),
    target: path,
    data: body,
    mode: "replace",
  });
  return path;
}

/**
 * Remove the root kill-switch flag when present.
 * @returns true when a file was removed.
 */
export function removeDeftDirectiveDisableFlag(projectRoot: string): boolean {
  const path = deftDirectiveDisableFlagPath(projectRoot);
  if (!existsSync(path)) {
    return false;
  }
  assertWriteTargetSafe(projectRoot, path);
  if (defaultIsDir(path)) {
    throw new Error(
      `${DEFT_DIRECTIVE_DISABLE_FLAG_NAME} exists as a directory at ${path}; remove the directory manually before re-enabling Directive.`,
    );
  }
  unlinkSync(path);
  return true;
}
