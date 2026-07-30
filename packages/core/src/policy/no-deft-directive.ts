/**
 * Official per-project opt-out flag for Directive (#2926).
 *
 * Presence of root `.no-deft-directive` means this project does not use
 * Directive. Session ritual, doctor setup pressure, init/update install paths,
 * and setup skills must honor the flag. Empty file or a short comment is enough.
 *
 * Product choices (v1):
 * - Flag is **root-only** (workspace root the tool opened). Nested monorepo
 *   package roots are a documented follow-up.
 * - Flag **wins locally** over ambient trusted-org / product-signal force-on.
 * - Flag + deposit (`.deft/core`) is **inconsistent**: doctor **warns**;
 *   mutating install/update paths **fail closed**.
 * - Creating the flag does **not** delete an existing deposit.
 */

import { existsSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { assertWriteTargetSafe } from "../fs/projection-containment.js";
import { CANONICAL_INSTALL_ROOT } from "../init-deposit/constants.js";

/** Canonical root-only filename (lowercase). Presence = flag. */
export const NO_DEFT_DIRECTIVE_FLAG_NAME = ".no-deft-directive";

/** One-line operator message when Directive is disabled by the flag. */
export const NO_DEFT_DIRECTIVE_DISABLED_MESSAGE = "Directive disabled via `.no-deft-directive`";

/**
 * Loud diagnosis when both the opt-out flag and a deposit exist.
 * Product choice (#2926): doctor **warns**; install/update **fail closed**.
 */
export const NO_DEFT_DIRECTIVE_INCONSISTENT_MESSAGE =
  "Inconsistent state: `.no-deft-directive` is present but a Directive deposit (`.deft/core`) also exists. Remove the flag to use Directive, or remove the deposit if opt-out is intentional.";

/** Recorded product choice for inconsistent flag+deposit handling. */
export const NO_DEFT_DIRECTIVE_INCONSISTENT_POLICY = "warn-and-fail-closed" as const;

export interface NoDeftDirectiveSeams {
  readonly isFile?: (path: string) => boolean;
  readonly isDir?: (path: string) => boolean;
}

export interface NoDeftDirectiveState {
  readonly present: boolean;
  readonly flagPath: string;
  readonly depositPresent: boolean;
  /** True when flag and deposit are both present. */
  readonly inconsistent: boolean;
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

/** Absolute path to the root flag file. */
export function noDeftDirectiveFlagPath(projectRoot: string): string {
  return resolve(projectRoot, NO_DEFT_DIRECTIVE_FLAG_NAME);
}

/**
 * Detect root `.no-deft-directive` and whether a deposit is also present.
 * Presence is file-existence only (empty or short comment OK).
 */
export function detectNoDeftDirective(
  projectRoot: string,
  seams: NoDeftDirectiveSeams = {},
): NoDeftDirectiveState {
  const flagPath = noDeftDirectiveFlagPath(projectRoot);
  const isFile = seams.isFile ?? defaultIsFile;
  const isDir = seams.isDir ?? defaultIsDir;
  const present = isFile(flagPath);
  const depositPresent = isDir(join(projectRoot, CANONICAL_INSTALL_ROOT));
  return {
    present,
    flagPath,
    depositPresent,
    inconsistent: present && depositPresent,
  };
}

/** True when the root opt-out flag file exists. */
export function isNoDeftDirectivePresent(
  projectRoot: string,
  seams: NoDeftDirectiveSeams = {},
): boolean {
  return detectNoDeftDirective(projectRoot, seams).present;
}

/**
 * Create the root opt-out flag. Optional one-line rationale becomes a `#` comment.
 * Does not remove an existing deposit.
 */
export function createNoDeftDirectiveFlag(
  projectRoot: string,
  options: { rationale?: string } = {},
): string {
  const path = noDeftDirectiveFlagPath(projectRoot);
  if (defaultIsDir(path)) {
    throw new Error(
      `${NO_DEFT_DIRECTIVE_FLAG_NAME} exists as a directory at ${path}; remove it before creating the opt-out flag file.`,
    );
  }
  const rationale = options.rationale?.trim() ?? "";
  const body = rationale.length > 0 ? `# ${rationale}\n` : "";
  // #2951: product write sinks route through containedWrite (create|replace).
  // Use replace so re-running with a new rationale updates the flag file.
  containedWrite({
    root: resolve(projectRoot),
    target: path,
    data: body,
    mode: "replace",
  });
  return path;
}

/**
 * Remove the root opt-out flag when present.
 * @returns true when a file was removed.
 */
export function removeNoDeftDirectiveFlag(projectRoot: string): boolean {
  const path = noDeftDirectiveFlagPath(projectRoot);
  if (!existsSync(path)) {
    return false;
  }
  assertWriteTargetSafe(projectRoot, path);
  if (defaultIsDir(path)) {
    throw new Error(
      `${NO_DEFT_DIRECTIVE_FLAG_NAME} exists as a directory at ${path}; remove the directory manually before enabling Directive.`,
    );
  }
  unlinkSync(path);
  return true;
}
