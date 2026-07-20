import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { locateManifest, parseInstallManifest } from "../doctor/manifest.js";
import {
  evaluateReleaseAvailability,
  type ReleaseAvailabilityResult,
} from "../doctor/release-availability.js";
import type { ParsedSemverCore } from "./types.js";

const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org/";

export interface ProbeDirectiveOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly readText?: (path: string) => string | null;
  readonly isFile?: (path: string) => boolean;
  readonly runNpmView?: () => { ok: boolean; version: string };
}

function defaultReadText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function defaultNpmView(): { ok: boolean; version: string } {
  const result = spawnSync(
    "npm",
    [
      "view",
      "@deftai/directive",
      "version",
      `--registry=${PUBLIC_NPM_REGISTRY}`,
      "--ignore-scripts",
    ],
    { encoding: "utf8", timeout: 5_000 },
  );
  const version = (result.stdout ?? "").trim().split(/\r?\n/)[0]?.trim() ?? "";
  return { ok: result.status === 0 && version.length > 0, version };
}

/** Parse `X.Y.Z` or `vX.Y.Z` core semver (ignores pre-release suffix). */
export function parseSemverCore(version: string): ParsedSemverCore | null {
  const trimmed = version.trim().replace(/^v/i, "");
  const core = trimmed.split("-")[0] ?? "";
  const parts = core.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  const patch = Number(parts[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null;
  }
  return { major, minor, patch };
}

export function computeDirectiveDistance(
  installedVersion: string,
  latestVersion: string,
): { majorBehind: boolean; minorDistance: number; patchDistance: number } {
  const installed = parseSemverCore(installedVersion);
  const latest = parseSemverCore(latestVersion);
  if (installed === null || latest === null) {
    return { majorBehind: false, minorDistance: 0, patchDistance: 0 };
  }
  if (latest.major > installed.major) {
    return {
      majorBehind: true,
      minorDistance: 0,
      patchDistance: 0,
    };
  }
  if (latest.major < installed.major) {
    return { majorBehind: false, minorDistance: 0, patchDistance: 0 };
  }
  return {
    majorBehind: false,
    minorDistance: Math.max(0, latest.minor - installed.minor),
    patchDistance: Math.max(0, latest.patch - installed.patch),
  };
}

export interface ProbeDirectiveResult {
  readonly availability: ReleaseAvailabilityResult;
  readonly majorBehind: boolean;
  readonly minorDistance: number;
  readonly patchDistance: number;
  readonly stale: boolean;
  readonly registryDisclosure: string;
}

/**
 * Probe Directive payload staleness via the public npm registry (#1692 substrate).
 * Skips network when `DEFT_NO_NETWORK=1`.
 */
export function probeDirectiveStaleness(
  projectRoot: string,
  options: ProbeDirectiveOptions = {},
): ProbeDirectiveResult | null {
  const env = options.env ?? process.env;
  const disclosure = `[deft staleness] Checking ${PUBLIC_NPM_REGISTRY} for Directive release drift.`;
  if (env.DEFT_NO_NETWORK === "1") {
    return null;
  }
  const readText = options.readText ?? defaultReadText;
  const isFile = options.isFile ?? existsSync;
  const manifestPath = locateManifest(projectRoot, null, isFile);
  const manifestText = manifestPath ? readText(manifestPath) : null;
  if (manifestText === null) {
    return null;
  }
  const manifest = parseInstallManifest(manifestText);
  const installed = (manifest.tag ?? manifest.ref ?? "").trim();
  const notApplicable = evaluateReleaseAvailability(installed, null);
  if (notApplicable.status === "not-applicable") {
    return null;
  }

  let npmResult: { ok: boolean; version: string };
  try {
    npmResult = (options.runNpmView ?? defaultNpmView)();
  } catch {
    npmResult = { ok: false, version: "" };
  }
  const availability = evaluateReleaseAvailability(
    installed,
    npmResult.ok ? npmResult.version : null,
  );
  const stale = availability.status === "available";
  let distance = { majorBehind: false, minorDistance: 0, patchDistance: 0 };
  if (availability.status === "available" || availability.status === "current") {
    distance = computeDirectiveDistance(availability.installedVersion, availability.latestVersion);
  }
  return {
    availability,
    ...distance,
    stale,
    registryDisclosure: disclosure,
  };
}
