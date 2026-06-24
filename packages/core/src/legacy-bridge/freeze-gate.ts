/**
 * freeze-gate.ts -- Tier-1 freeze gate for the legacy Go-installer bridge (#1912).
 *
 * Reads the Tier-0 SoT (`lastGoInstaller`) and the in-repo Go-installer source
 * version constant (`var version = "..."` in `cmd/deft-install/main.go`) and
 * enforces the freeze line:
 *
 *   - SoT null (NOT yet frozen): PASS (advisory). Go-installer development is
 *     still allowed up to the cut; the gate does not even read the installer
 *     source in this state.
 *   - SoT pinned (frozen): FAIL when the `cmd/deft-install` version is ABOVE the
 *     pinned tag -- i.e. someone is preparing a Go-installer release past the
 *     frozen line. At-or-below the line PASSES (re-publishing the pinned tag is
 *     allowed).
 *
 * Three-state exit (mirrors verify-source/content-manifest + scm-boundary):
 *   0 -- ok (advisory-when-null, or at/below the line when frozen).
 *   1 -- violation: frozen and the installer version is above the pinned tag.
 *   2 -- config error: installer source missing / unparseable, or the SoT value
 *        is pinned to an unparseable version.
 *
 * No version number is hardcoded here: the frozen tag comes from the SoT module
 * and the installer version is parsed from `cmd/deft-install/main.go` at runtime.
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
  /** Test seam: override the parsed installer version (undefined = read the source). */
  readonly installerVersion?: string;
  /** Override the repo-relative installer source path. */
  readonly installerVersionPath?: string;
  /** When true, downgrade a violation to an advisory pass (emergency bypass). */
  readonly allowBump?: boolean;
}

/**
 * Evaluate the freeze gate. Pure-ish: reads the installer source only when the
 * SoT is pinned (frozen) and no `installerVersion` override is supplied.
 */
export function evaluateGoFreeze(
  projectRoot: string,
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

  try {
    const installer =
      options.installerVersion !== undefined
        ? options.installerVersion
        : readInstallerVersion(resolve(projectRoot), options.installerVersionPath);

    let cmp: -1 | 0 | 1;
    try {
      cmp = compareInstallerVersions(installer, pinned);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        code: EXIT_CONFIG_ERROR,
        message: `Error: cannot compare versions (${msg}). Check the SoT value and the cmd/deft-install version constant.`,
        stream: "stderr",
      };
    }

    if (cmp > 0) {
      if (options.allowBump) {
        return {
          code: EXIT_OK,
          message:
            `OK (bypass): cmd/deft-install version ${installer} is ABOVE the frozen bridge tag ${pinned}, ` +
            `but ${FREEZE_BYPASS_ENV}=1 downgraded the violation to advisory.`,
          stream: "stdout",
        };
      }
      return {
        code: EXIT_VIOLATION,
        message:
          `FAIL: cmd/deft-install version ${installer} is ABOVE the frozen bridge tag ${pinned}.\n` +
          "  The last Go installer was frozen as the legacy stage-1 bridge (#1912); no Go-installer\n" +
          "  release past the pinned tag is allowed. Roll the cmd/deft-install version back to the\n" +
          `  frozen tag (${pinned}) or below. Emergency bypass: ${FREEZE_BYPASS_ENV}=1.`,
        stream: "stderr",
      };
    }

    return {
      code: EXIT_OK,
      message:
        `OK: the Go installer is frozen at ${pinned}; cmd/deft-install version ${installer} ` +
        "is at or below the frozen line.",
      stream: "stdout",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { code: EXIT_CONFIG_ERROR, message: `Error: ${msg}`, stream: "stderr" };
  }
}
