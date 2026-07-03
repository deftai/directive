/**
 * Local-engine integrity check for the resolution spine (#2264, from #2124).
 *
 * A locally-installed engine at `.deft/.cli/<platform>` is only usable when the
 * install completed. A present-but-partial directory (an interrupted
 * `npm install --prefix`) must be treated as NOT-USABLE — otherwise the ladder
 * would select a half-installed engine and fail at execution time instead of
 * falling through to a clean re-install.
 */

import { existsSync } from "node:fs";
import { platform as osPlatform } from "node:os";
import { join } from "node:path";

/** Root of the sandbox-local engine install, relative to the project root. */
export const LOCAL_ENGINE_ROOT = ".deft/.cli";

/**
 * Marker paths (relative to the platform install dir) that MUST all exist for a
 * local engine to count as a completed, usable install. `package.json` marks the
 * install root; the `directive` bin under `node_modules/.bin` marks that npm
 * finished linking the executable.
 */
export const LOCAL_ENGINE_MARKERS: readonly string[] = [
  "package.json",
  join("node_modules", ".bin", "directive"),
];

export interface IntegritySeams {
  readonly isFile?: (p: string) => boolean;
  readonly isDir?: (p: string) => boolean;
  readonly platform?: string;
}

export interface IntegrityResult {
  /** The install is complete and the engine may be selected. */
  readonly usable: boolean;
  /** The platform install directory exists at all (vs. wholly absent). */
  readonly present: boolean;
  /** Present but missing required markers (interrupted install). */
  readonly partial: boolean;
  /** Absolute-relative platform install directory that was probed. */
  readonly platformDir: string;
  /** Marker paths that were missing. */
  readonly missingMarkers: readonly string[];
  /** Human-facing reason. */
  readonly reason: string;
}

function defaultIsFile(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

/** Resolve the platform-specific local engine directory (e.g. `.deft/.cli/linux`). */
export function localEnginePlatformDir(projectRoot: string, platform?: string): string {
  const plat = platform ?? osPlatform();
  return join(projectRoot, LOCAL_ENGINE_ROOT, plat);
}

/**
 * Classify the local engine install at `.deft/.cli/<platform>`.
 *
 * - wholly absent            -> `{ usable: false, present: false, partial: false }`
 * - present, all markers     -> `{ usable: true,  present: true,  partial: false }`
 * - present, missing markers -> `{ usable: false, present: true,  partial: true  }`
 */
export function checkLocalEngineIntegrity(
  projectRoot: string,
  seams: IntegritySeams = {},
): IntegrityResult {
  const isFile = seams.isFile ?? defaultIsFile;
  const isDir = seams.isDir ?? seams.isFile ?? defaultIsFile;
  const platformDir = localEnginePlatformDir(projectRoot, seams.platform);

  const rootPresent = isDir(platformDir);
  const missingMarkers = LOCAL_ENGINE_MARKERS.filter(
    (marker) => !isFile(join(platformDir, marker)),
  );

  if (!rootPresent && missingMarkers.length === LOCAL_ENGINE_MARKERS.length) {
    return {
      usable: false,
      present: false,
      partial: false,
      platformDir,
      missingMarkers,
      reason: `no local engine at ${platformDir}`,
    };
  }

  if (missingMarkers.length > 0) {
    return {
      usable: false,
      present: true,
      partial: true,
      platformDir,
      missingMarkers,
      reason: `partial local engine at ${platformDir} (missing: ${missingMarkers.join(", ")}) -- treated as not-usable`,
    };
  }

  return {
    usable: true,
    present: true,
    partial: false,
    platformDir,
    missingMarkers: [],
    reason: `intact local engine at ${platformDir}`,
  };
}
