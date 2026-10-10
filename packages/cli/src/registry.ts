/**
 * Registry target resolution for install (AC6.1).
 * Resolves latest stable via `npm view`; rejects ranges/tags as user specs.
 */
import { spawnSync } from "node:child_process";
import { RUNTIME_PACKAGE_NAME } from "./constants.js";
import { isExactSemver, isPrereleaseVersion } from "./pm.js";

export type ValidateTargetResult =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly message: string };

/** User-supplied --target-version must already be an exact SemVer (incl. prerelease). */
export function validateTargetVersionSpec(raw: string): ValidateTargetResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: "--target-version requires an exact version." };
  }
  if (trimmed === "latest" || trimmed === "next" || trimmed === "canary") {
    return {
      ok: false,
      message: `--target-version rejects tags (${trimmed}); pass an exact version.`,
    };
  }
  if (!isExactSemver(trimmed)) {
    return {
      ok: false,
      message: `--target-version must be an exact SemVer (got ${trimmed}). Ranges and tags are rejected.`,
    };
  }
  return { ok: true, version: trimmed };
}

export type ResolveLatestResult =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly message: string };

/**
 * Resolve the registry "latest" tag to an exact version, then reject prereleases
 * unless the caller already passed --target-version (AC6.1).
 */
export function resolveLatestStableVersion(
  env: NodeJS.ProcessEnv = process.env,
): ResolveLatestResult {
  const result = spawnSync(
    "npm",
    ["view", RUNTIME_PACKAGE_NAME, "version", "--json"],
    {
      encoding: "utf8",
      env,
      shell: process.platform === "win32",
    },
  );
  if (result.error) {
    return {
      ok: false,
      message: `Failed to query registry for ${RUNTIME_PACKAGE_NAME}: ${result.error.message}`,
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      message:
        `npm view ${RUNTIME_PACKAGE_NAME} version failed` +
        (result.stderr ? `: ${result.stderr.trim()}` : ""),
    };
  }
  let version = (result.stdout ?? "").trim();
  // --json may quote the string
  if (version.startsWith('"') && version.endsWith('"')) {
    try {
      version = JSON.parse(version) as string;
    } catch {
      /* keep trimmed */
    }
  }
  if (!isExactSemver(version)) {
    return {
      ok: false,
      message: `Registry latest is not an exact SemVer (${version}).`,
    };
  }
  if (isPrereleaseVersion(version)) {
    return {
      ok: false,
      message:
        `Registry latest (${version}) is a prerelease. Pass --target-version <exact> to install it (AC6.1).`,
    };
  }
  return { ok: true, version };
}
