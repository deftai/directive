/**
 * Cheap in-sync check for hooks (AC2.4).
 *
 * Checks pin/installed-runtime identity + readiness validity only.
 * Designed to be fast on a warm filesystem; unit-testable without sleeping.
 * Full setup is not repeated on this path when readiness is valid.
 *
 * Pin≠installed fails closed with project PM install guidance (#6013 / #5893);
 * no setup (AC2.6). AC9.7 global+repair is for deposits after packages match.
 * Materialize overlay present fails closed even when versions match (#5910);
 * recovery names frozen-lockfile restore then overlay retirement.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ENTRY_GUARD_MESSAGES,
  formatEntryGuardMessage,
  PIN_MISMATCH_PROJECT_PM_RECOVERY_GUIDANCE,
  projectInstallCommand,
} from "./constants.js";
import {
  type FsSeams,
  readInstalledRuntimeVersion,
  readReadiness,
  readRuntimePin,
} from "./readers.js";
import type { CheapInSyncResult } from "./types.js";

/** Tip→pin materialize overlay marker (#5805 / #5910). */
export const MATERIALIZE_RUNTIME_OVERLAY_REL = ".deft-scratch/materialize-runtime-overlay.json";

/** Release cut-context marker (#5910); materialize refuses while present. */
export const RELEASE_CUT_CONTEXT_REL = ".deft-scratch/release-cut-context.json";

/**
 * Operator-terminal recovery when the materialize overlay is present (#5910).
 * Exact restore first; retire the overlay before identity may pass.
 */
export const OVERLAY_RESTORE_RECOVERY_GUIDANCE = ENTRY_GUARD_MESSAGES.overlay;

function overlayPresent(projectRoot: string, seams: FsSeams): boolean {
  const overlayPath = join(projectRoot, MATERIALIZE_RUNTIME_OVERLAY_REL);
  if (seams.isFile) {
    return seams.isFile(overlayPath);
  }
  try {
    return existsSync(overlayPath);
  } catch {
    return false;
  }
}

/**
 * Fast hook path: identity + readiness. Does not inspect lockfile, generation,
 * or wiring inventory (those belong to the full check / doctor).
 */
export function checkCheapInSync(projectRoot: string, seams: FsSeams = {}): CheapInSyncResult {
  const pinRead = readRuntimePin(projectRoot, seams);
  const pinVersion = pinRead.pinVersion;
  const installedVersion = readInstalledRuntimeVersion(projectRoot, seams);

  const identityMatch =
    pinVersion !== null && installedVersion !== null && pinVersion === installedVersion;

  const identityMismatch =
    pinVersion !== null && installedVersion !== null && pinVersion !== installedVersion;

  const hasOverlay = overlayPresent(projectRoot, seams);
  // Overlay keeps fail-closed even when versions match so a version-string
  // spoof cannot clear identity while the marker remains (#5910 P3).
  const failClosed = identityMismatch || hasOverlay;
  const allowSetup = !failClosed;

  let readinessValid = false;
  if (pinVersion !== null) {
    const ready = readReadiness(projectRoot, pinVersion, seams);
    readinessValid = ready.present && ready.versionMatch;
  }

  const ok = identityMatch && readinessValid && !failClosed;

  let recoveryGuidance: string | null = null;
  if (failClosed) {
    recoveryGuidance = hasOverlay
      ? OVERLAY_RESTORE_RECOVERY_GUIDANCE
      : PIN_MISMATCH_PROJECT_PM_RECOVERY_GUIDANCE;
  }

  return {
    ok,
    pinVersion,
    installedVersion,
    identityMatch,
    readinessValid,
    failClosed,
    pinMismatchOnly: identityMismatch && !hasOverlay,
    allowSetup,
    recoveryGuidance,
  };
}

/**
 * The runtime's own pin check for ordinary commands (AC2.6, #6620).
 *
 * Before any command operates, the runtime confirms its installed version
 * equals the exact pin, however it was started: launcher, git hook or
 * Taskfile. On a mismatch it names the project install (AC9.12) and the
 * command does not run. Only a version mismatch counts here; the materialize
 * overlay is a hook-only rule (#5910).
 *
 * Exempt: `doctor` (read-only diagnosis must still run), `--version`,
 * `--help`, and `hook:dispatch` (the hook path has its own check, with the
 * #6313 install admit).
 */

const EXEMPT_VERBS: ReadonlySet<string> = new Set([
  "doctor",
  "hook:dispatch",
  "help",
  "version",
  "--version",
  "-V",
  "--help",
  "-h",
]);
const HELP_FLAGS: ReadonlySet<string> = new Set(["--help", "-h"]);

/**
 * The project a runtime command acts on, for the pin check: an explicit
 * `--project-root <path>` (or `=path`) wins, resolved against `cwd`; when it
 * is repeated, the last one wins, as in the command handlers (task wrappers
 * prepend one before the caller's own). Else `fallback`
 * (`DIRECTIVE_PROJECT_ROOT` or the working directory).
 */
export function runtimeCommandProjectRoot(
  argv: readonly string[],
  fallback: string,
  cwd: string = process.cwd(),
): string {
  let found: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const value =
      arg === "--project-root"
        ? argv[i + 1]
        : arg.startsWith("--project-root=")
          ? arg.slice("--project-root=".length)
          : undefined;
    if (value !== undefined && value.length > 0) found = value;
  }
  return found === null ? fallback : resolve(cwd, found);
}

/**
 * True when `argv` runs a command the identity check leaves alone. The first
 * token decides, as in the router (`route-argv.ts`). A later `--help` / `-h`
 * also exempts when it is a flag of its own: right after the verb, after an
 * option's value, or after an `--option=value`; never as the value of a
 * preceding bare option (`--note --help`), and `--version` never exempts
 * after the first token.
 */
export function isIdentityExempt(argv: readonly string[]): boolean {
  const first = argv[0];
  if (first === undefined) return true;
  if (EXEMPT_VERBS.has(first)) return true;
  for (let i = 1; i < argv.length; i++) {
    if (!HELP_FLAGS.has(argv[i] ?? "")) continue;
    const previous = argv[i - 1] ?? "";
    if (i === 1 || !previous.startsWith("-") || previous.includes("=")) return true;
  }
  return false;
}

/**
 * The `pin-mismatch` row when the installed runtime is not the pinned version
 * and `argv` is not exempt; null otherwise (including when either version is
 * unknown).
 */
export function runtimeIdentityRefusal(
  projectRoot: string,
  argv: readonly string[],
  cheapInSync: (root: string) => CheapInSyncResult = (root) => checkCheapInSync(root),
): string | null {
  if (isIdentityExempt(argv)) return null;
  const { pinVersion, installedVersion } = cheapInSync(projectRoot);
  if (pinVersion === null || installedVersion === null || pinVersion === installedVersion) {
    return null;
  }
  return formatEntryGuardMessage("pin-mismatch", {
    install: projectInstallCommand(projectRoot),
    pin: pinVersion,
    installed: installedVersion,
  });
}
