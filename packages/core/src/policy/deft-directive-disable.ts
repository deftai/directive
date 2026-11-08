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
 *
 * Eligibility (#6122 / Prefer-A Bound): override only when positively validated
 * eligible (project-root non-symlink regular file + successful untracked
 * `git ls-files` listing). Tracked / wrong kind / absent → ineligible.
 * Probe launch failure, nonzero status, timeout, or unavailable output →
 * indeterminate (never active; never cached as untracked).
 */

import { execFileSync } from "node:child_process";
import { lstatSync, statSync } from "node:fs";
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
  "The flag is present: stop Directive process load (AGENTS.md Temporary test kill-switch #3039).\n" +
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

/**
 * Three-way operator-override eligibility (#6122).
 * Only `eligible` selects the kill-switch short-circuit.
 */
export type OperatorDisableEligibility = "eligible" | "ineligible" | "indeterminate";

/** Successful `git ls-files` listing outcome (cacheable). */
export type GitTrackListingOutcome = "tracked" | "untracked";

/** Listing probe result including indeterminate inspection failures. */
export type GitTrackProbeResult = GitTrackListingOutcome | "indeterminate";

/** Process-local cache: successful tracked|untracked only — never indeterminate. */
const trackedProbeCache = new Map<string, { readonly tracked: boolean; readonly atMs: number }>();
const TRACKED_PROBE_CACHE_TTL_MS = 30_000;

/** Test helper: drop cached listing outcomes. */
export function clearDeftDirectiveDisableTrackedProbeCache(): void {
  trackedProbeCache.clear();
}

export interface DeftDirectiveDisableSeams {
  readonly isFile?: (path: string) => boolean;
  readonly isDir?: (path: string) => boolean;
  /**
   * Legacy boolean seam: true = tracked, false = untracked.
   * Does not model indeterminate; prefer `probeGitTrackListing` for that.
   */
  readonly isGitTracked?: (projectRoot: string, relPath: string) => boolean;
  /** Three-way listing probe; wins over `isGitTracked` when both are set. */
  readonly probeGitTrackListing?: (projectRoot: string, relPath: string) => GitTrackProbeResult;
  /** Skip tracked probe + cache (tests / doctor full re-check). */
  readonly skipTrackedCache?: boolean;
  /**
   * Adapter seam for the default `git ls-files` capture used by
   * `probeGitLsFilesListing` (cached + skipTrackedCache paths). Throw to
   * model launch/nonzero failure; return stdout string on success.
   */
  readonly gitLsFilesCapture?: (projectRoot: string, relPath: string) => string;
}

export interface DeftDirectiveDisableState {
  readonly present: boolean;
  readonly flagPath: string;
  readonly depositPresent: boolean;
  /**
   * True when the flag file is tracked by git (misconfig — should be gitignored).
   * Always false when the flag is absent or when the probe is not a successful
   * tracked listing (including indeterminate).
   */
  readonly trackedByGit: boolean;
  /** Three-way eligibility; `active` is true only when this is `eligible`. */
  readonly eligibility: OperatorDisableEligibility;
  /**
   * True when the kill-switch is **active** for enforcement short-circuit:
   * positively validated eligible (present regular file + successful untracked listing).
   */
  readonly active: boolean;
}

/**
 * Regular-file check that does **not** treat a symlink as an intentional kill-switch
 * (#3213 residual after #3206). `statSync().isFile()` follows links, so
 * `ln -sf /etc/hosts .deft-directive-disable` would activate enforcement off.
 * Prefer `lstatSync`: only a non-symlink regular file counts as present.
 */
function defaultIsFile(path: string): boolean {
  try {
    const lst = lstatSync(path);
    // Attacker-planted symlink → not an intentional operator flag (#3213).
    if (lst.isSymbolicLink()) return false;
    return lst.isFile();
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

/**
 * Explicit Git success predicate (#6122): successful `git ls-files` with usable
 * captured output. Empty listing = untracked; nonempty = tracked; launch failure,
 * nonzero, timeout, or unavailable output = indeterminate.
 */
export function probeGitLsFilesListing(
  projectRoot: string,
  relPath: string,
  capture?: (projectRoot: string, relPath: string) => string,
): GitTrackProbeResult {
  try {
    const out =
      capture !== undefined
        ? capture(projectRoot, relPath)
        : execFileSync("git", ["ls-files", "--", relPath], {
            cwd: projectRoot,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: GIT_TRACKED_PROBE_TIMEOUT_MS,
          });
    if (typeof out !== "string") return "indeterminate";
    return out.trim().length > 0 ? "tracked" : "untracked";
  } catch {
    return "indeterminate";
  }
}

function defaultProbeGitTrackListing(
  projectRoot: string,
  relPath: string,
  capture?: (projectRoot: string, relPath: string) => string,
): GitTrackProbeResult {
  const cacheKey = `${projectRoot}\0${relPath}`;
  const now = Date.now();
  const cached = trackedProbeCache.get(cacheKey);
  if (cached !== undefined && now - cached.atMs < TRACKED_PROBE_CACHE_TTL_MS) {
    return cached.tracked ? "tracked" : "untracked";
  }
  const result = probeGitLsFilesListing(projectRoot, relPath, capture);
  if (result === "tracked" || result === "untracked") {
    trackedProbeCache.set(cacheKey, { tracked: result === "tracked", atMs: now });
  }
  return result;
}

function resolveTrackProbe(
  projectRoot: string,
  seams: DeftDirectiveDisableSeams,
): GitTrackProbeResult {
  if (seams.probeGitTrackListing) {
    return seams.probeGitTrackListing(projectRoot, DEFT_DIRECTIVE_DISABLE_FLAG_NAME);
  }
  if (seams.isGitTracked) {
    return seams.isGitTracked(projectRoot, DEFT_DIRECTIVE_DISABLE_FLAG_NAME)
      ? "tracked"
      : "untracked";
  }
  if (seams.skipTrackedCache) {
    return probeGitLsFilesListing(
      projectRoot,
      DEFT_DIRECTIVE_DISABLE_FLAG_NAME,
      seams.gitLsFilesCapture,
    );
  }
  return defaultProbeGitTrackListing(
    projectRoot,
    DEFT_DIRECTIVE_DISABLE_FLAG_NAME,
    seams.gitLsFilesCapture,
  );
}

function eligibilityFromPresentProbe(
  present: boolean,
  probe: GitTrackProbeResult,
): {
  readonly eligibility: OperatorDisableEligibility;
  readonly trackedByGit: boolean;
} {
  if (!present) {
    return { eligibility: "ineligible", trackedByGit: false };
  }
  if (probe === "tracked") {
    return { eligibility: "ineligible", trackedByGit: true };
  }
  if (probe === "untracked") {
    return { eligibility: "eligible", trackedByGit: false };
  }
  return { eligibility: "indeterminate", trackedByGit: false };
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
 * Enforcement short-circuit uses `state.active` (eligibility === "eligible").
 */
export function detectDeftDirectiveDisable(
  projectRoot: string,
  seams: DeftDirectiveDisableSeams = {},
): DeftDirectiveDisableState {
  const flagPath = deftDirectiveDisableFlagPath(projectRoot);
  const isFile = seams.isFile ?? defaultIsFile;
  const isDir = seams.isDir ?? defaultIsDir;
  const present = isFile(flagPath);
  const depositPresent = isDir(join(projectRoot, CANONICAL_INSTALL_ROOT));
  const probe: GitTrackProbeResult = present ? resolveTrackProbe(projectRoot, seams) : "untracked";
  const { eligibility, trackedByGit } = eligibilityFromPresentProbe(present, probe);
  return {
    present,
    flagPath,
    depositPresent,
    trackedByGit,
    eligibility,
    active: eligibility === "eligible",
  };
}

/**
 * True when the local (untracked) kill-switch is active for enforcement
 * short-circuit. Tracked / indeterminate flags return false so hooks stay enforced.
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
