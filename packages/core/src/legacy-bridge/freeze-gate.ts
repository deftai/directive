/**
 * freeze-gate.ts -- Tier-1 freeze gate for the legacy Go-installer bridge (#1912).
 *
 * Reads the Tier-0 SoT (`lastGoInstaller`) and weighs a candidate RELEASE TAG
 * against the frozen line:
 *
 *   - SoT null (NOT yet frozen): PASS (advisory). Go-installer development is
 *     still allowed up to the cut; the gate does not read the installer source
 *     in this state.
 *   - SoT pinned (frozen) + a release tag supplied: FAIL when the release tag is
 *     ABOVE the pinned tag -- i.e. someone is cutting a Go-installer release past
 *     the frozen line. At-or-below the line PASSES (re-publishing the pinned tag
 *     is allowed).
 *   - SoT pinned (frozen) + NO release tag supplied: PASS (advisory). There is no
 *     release being cut, so there is nothing to weigh; the enforcing teeth live
 *     in the release.yml tag guard, which runs only on a `v*.*.*` tag push.
 *
 * Why a release tag and not the installer source literal (#1972): the real
 * installer version is injected via `-ldflags "-X main.version=<tag>"` at build
 * time, so the `var version = "..."` literal in `cmd/deft-install/main.go` does
 * NOT reflect the released version. Comparing the pinned SoT against that stale
 * literal would false-fail the moment the SoT is pinned to a real 0.x tag. The
 * gate therefore keys off the release tag (`github.ref_name` in CI). The source
 * parsers below (`parseInstallerVersion` / `readInstallerVersion`) are retained
 * as release-time utilities but are no longer the freeze-decision input.
 *
 * Three-state exit (mirrors verify-source/content-manifest + scm-boundary):
 *   0 -- ok (advisory-when-null / advisory-when-no-tag, or at/below the line).
 *   1 -- violation: frozen and the release tag is above the pinned tag.
 *   2 -- config error: the SoT value or the release tag is unparseable.
 *
 * No version number is hardcoded here: the frozen tag comes from the SoT module
 * and the candidate tag is supplied by the caller (the release pipeline) at
 * runtime.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { lastGoInstaller } from "./sot.js";

const EXIT_OK = 0;
const EXIT_VIOLATION = 1;
const EXIT_CONFIG_ERROR = 2;

/** Repo-relative path to the Go installer source carrying the version constant. */
export const DEFAULT_INSTALLER_VERSION_PATH = "cmd/deft-install/main.go";

/** Per-shell emergency bypass env var (consistent with the other deft gates). */
export const FREEZE_BYPASS_ENV = "DEFT_ALLOW_GO_INSTALLER_BUMP";

/** Extract the `var version = "X"` literal from Go installer source, or null. */
export function parseInstallerVersion(source: string): string | null {
  const match = source.match(/var\s+version\s*=\s*"([^"]+)"/);
  return match?.[1] ?? null;
}

/** Read + parse the Go installer version constant. Throws (caller maps to 2). */
export function readInstallerVersion(
  projectRoot: string,
  relPath: string = DEFAULT_INSTALLER_VERSION_PATH,
): string {
  const full = resolve(projectRoot, relPath);
  if (!existsSync(full)) {
    throw new Error(
      `Go installer source not found: ${full} -- expected the \`var version = "..."\` constant at ${relPath}.`,
    );
  }
  let source: string;
  try {
    source = readFileSync(full, { encoding: "utf8" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read Go installer source ${full}: ${msg}`);
  }
  const version = parseInstallerVersion(source);
  if (version === null) {
    throw new Error(
      `Could not parse \`var version = "..."\` from ${relPath}; the Go installer version constant is missing or malformed.`,
    );
  }
  return version;
}

interface SemverCore {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** Parse the numeric major.minor.patch core, tolerating a leading `v` and a `-`/`+` suffix. */
function parseSemverCore(raw: string): SemverCore {
  const trimmed = raw.trim().replace(/^v/i, "");
  const core = trimmed.split(/[-+]/, 1)[0] ?? "";
  const parts = core.split(".");
  if (parts.length === 0 || parts[0] === "") {
    throw new Error(`unparseable version: '${raw}'`);
  }
  const nums = parts.map((p) => {
    if (!/^\d+$/.test(p)) {
      throw new Error(`unparseable version: '${raw}'`);
    }
    return Number.parseInt(p, 10);
  });
  return { major: nums[0] ?? 0, minor: nums[1] ?? 0, patch: nums[2] ?? 0 };
}

/**
 * Compare two installer version strings by numeric major.minor.patch core.
 * Returns -1 (a < b), 0 (a == b), or 1 (a > b). Throws on an unparseable input
 * (caller maps to config error). Pre-release / build metadata is ignored for the
 * "above the line" determination.
 */
export function compareInstallerVersions(a: string, b: string): -1 | 0 | 1 {
  const av = parseSemverCore(a);
  const bv = parseSemverCore(b);
  for (const key of ["major", "minor", "patch"] as const) {
    if (av[key] < bv[key]) return -1;
    if (av[key] > bv[key]) return 1;
  }
  return 0;
}

export interface FreezeResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: "stdout" | "stderr";
}

export interface FreezeEvaluateOptions {
  /** Test seam: override the SoT value (undefined = read the live SoT module). */
  readonly pinned?: string | null;
  /**
   * The candidate release tag to weigh against the frozen line (CI:
   * `github.ref_name`). When undefined / null the gate is advisory: there is no
   * release being cut, so there is nothing to enforce -- the teeth live in the
   * release.yml tag guard. This replaces the brittle source-literal comparison
   * (#1972): the real installer version is ldflags-injected at build time, so
   * the `var version` source literal does not reflect the released version.
   */
  readonly releaseTag?: string | null;
  /** When true, downgrade a violation to an advisory pass (emergency bypass). */
  readonly allowBump?: boolean;
}

/**
 * Evaluate the freeze gate against a candidate release tag.
 *
 * The first parameter is retained for call-site signature compatibility (the
 * `verify-go-freeze` CLI passes a project root positionally); the gate no longer
 * reads the installer source, so the value is unused here (#1972).
 */
export function evaluateGoFreeze(
  _projectRoot: string,
  options: FreezeEvaluateOptions = {},
): FreezeResult {
  const pinned = options.pinned !== undefined ? options.pinned : lastGoInstaller();

  if (pinned === null) {
    return {
      code: EXIT_OK,
      message:
        "OK (advisory): the Go installer is not frozen (SoT lastGoInstaller is null). " +
        "Go-installer development is still allowed up to the cut.",
      stream: "stdout",
    };
  }

  const releaseTag = options.releaseTag ?? null;
  if (releaseTag === null) {
    return {
      code: EXIT_OK,
      message:
        `OK (advisory): the Go installer is frozen at ${pinned}, but no release tag was supplied ` +
        "to weigh against the frozen line. Freeze enforcement runs in the release.yml tag guard " +
        "on a v*.*.* push; this local gate is advisory.",
      stream: "stdout",
    };
  }

  let cmp: -1 | 0 | 1;
  try {
    cmp = compareInstallerVersions(releaseTag, pinned);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      code: EXIT_CONFIG_ERROR,
      message: `Error: cannot compare versions (${msg}). Check the SoT value and the release tag.`,
      stream: "stderr",
    };
  }

  if (cmp > 0) {
    if (options.allowBump) {
      return {
        code: EXIT_OK,
        message:
          `OK (bypass): release tag ${releaseTag} is ABOVE the frozen bridge tag ${pinned}, ` +
          `but ${FREEZE_BYPASS_ENV}=1 downgraded the violation to advisory.`,
        stream: "stdout",
      };
    }
    return {
      code: EXIT_VIOLATION,
      message:
        `FAIL: release tag ${releaseTag} is ABOVE the frozen bridge tag ${pinned}.\n` +
        "  The last Go installer was frozen as the legacy stage-1 bridge (#1912); no Go-installer\n" +
        "  release past the pinned tag is allowed. Cut the release at or below the frozen tag\n" +
        `  (${pinned}), or roll the freeze SoT forward. Emergency bypass: ${FREEZE_BYPASS_ENV}=1.`,
      stream: "stderr",
    };
  }

  return {
    code: EXIT_OK,
    message:
      `OK: the Go installer is frozen at ${pinned}; release tag ${releaseTag} ` +
      "is at or below the frozen line.",
    stream: "stdout",
  };
}
