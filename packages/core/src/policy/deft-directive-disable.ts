/**
 * Temporary test/local kill-switch for Directive enforcement (#3039).
 *
 * Presence of root `.deft-directive-disable` means Directive **enforcement** is
 * OFF (hooks, session ritual, automation) while the deposit may remain — **only
 * when the file is not tracked by git**. A committed flag is misconfig: doctor
 * warns and enforcement stays ON (repository-controlled content must not disable
 * hooks for downstream clones).
 *
 * Distinct from `.no-deft-directive` (#2926 permanent opt-out): flag+deposit is
 * **not** inconsistent here.
 *
 * Product choices (v1):
 * - Flag is **root-only** (workspace root the tool opened).
 * - Flag **must be gitignored** (canonical baseline); committed flag → doctor
 *   warns and does **not** short-circuit enforcement.
 * - Deposit presence is **OK**.
 * - Full re-enable requires: delete the file **and** start a **new** agent session.
 * - Precedence: active kill-switch first, then `.no-deft-directive`, else normal.
 */

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { CANONICAL_INSTALL_ROOT } from "../init-deposit/constants.js";

/** Canonical root-only filename (lowercase). Presence = candidate flag. */
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

/** Doctor/status label when the kill-switch is active (local / untracked). */
export const DEFT_DIRECTIVE_DISABLE_STATUS = "disabled-test-kill-switch" as const;

/**
 * Warning when the kill-switch file is tracked by git (should be gitignored).
 * Tracked flags do **not** disable enforcement.
 */
export const DEFT_DIRECTIVE_DISABLE_TRACKED_WARNING =
  "Misconfig: `.deft-directive-disable` is tracked by git. The flag must be gitignored (local kill-switch only). Untrack it and ensure `.gitignore` covers the path. Enforcement is NOT disabled while the flag is tracked.";

/** Cap git probe so hot-path hooks never hang on a slow VCS call. */
const GIT_TRACKED_PROBE_TIMEOUT_MS = 1500;

/** Process-local cache: avoid re-spawning git on every PreToolUse while the flag is present. */
const trackedProbeCache = new Map<string, { readonly tracked: boolean; readonly atMs: number }>();
const TRACKED_PROBE_CACHE_TTL_MS = 30_000;

export interface DeftDirectiveDisableSeams {
  readonly isFile?: (path: string) => boolean;
  readonly isDir?: (path: string) => boolean;
  /** Return true when `git ls-files` lists the flag (tracked). */
  readonly isGitTracked?: (projectRoot: string, relPath: string) => boolean;
  /** Skip tracked probe + cache (tests / doctor full re-check). */
  readonly skipTrackedCache?: boolean;
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
  /**
   * True when the kill-switch is **active** for enforcement short-circuit:
   * present and **not** tracked by git.
   */
  readonly active: boolean;
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
  const cacheKey = `${projectRoot}\0${relPath}`;
  const now = Date.now();
  const cached = trackedProbeCache.get(cacheKey);
  if (cached !== undefined && now - cached.atMs < TRACKED_PROBE_CACHE_TTL_MS) {
    return cached.tracked;
  }
  let tracked = false;
  try {
    const out = execFileSync("git", ["ls-files", "--", relPath], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TRACKED_PROBE_TIMEOUT_MS,
    });
    tracked = out.trim().length > 0;
  } catch {
    tracked = false;
  }
  trackedProbeCache.set(cacheKey, { tracked, atMs: now });
  return tracked;
}

/** Absolute path to the root kill-switch flag file. */
export function deftDirectiveDisableFlagPath(projectRoot: string): string {
  return resolve(projectRoot, DEFT_DIRECTIVE_DISABLE_FLAG_NAME);
}

/**
 * Detect root `.deft-directive-disable`. Presence is file-existence only
 * (empty or short comment OK). Deposit presence is reported but never treated
 * as inconsistent (#3039 vs #2926).
 *
 * Enforcement short-circuit uses `state.active` (present && !trackedByGit).
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
  let trackedByGit = false;
  if (present) {
    if (seams.skipTrackedCache && seams.isGitTracked === undefined) {
      // Fresh probe without reading process cache (doctor / one-shot CLI).
      try {
        const out = execFileSync("git", ["ls-files", "--", DEFT_DIRECTIVE_DISABLE_FLAG_NAME], {
          cwd: projectRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: GIT_TRACKED_PROBE_TIMEOUT_MS,
        });
        trackedByGit = out.trim().length > 0;
      } catch {
        trackedByGit = false;
      }
    } else {
      trackedByGit = isGitTracked(projectRoot, DEFT_DIRECTIVE_DISABLE_FLAG_NAME);
    }
  }
  return {
    present,
    flagPath,
    depositPresent,
    trackedByGit,
    active: present && !trackedByGit,
  };
}

/**
 * True when the local (untracked) kill-switch is active for enforcement
 * short-circuit. Tracked flags return false so hooks stay enforced.
 */
export function isDeftDirectiveDisableActive(
  projectRoot: string,
  seams: DeftDirectiveDisableSeams = {},
): boolean {
  return detectDeftDirectiveDisable(projectRoot, seams).active;
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
