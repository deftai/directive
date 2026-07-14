import { comparePublishableVersions, isPrereleaseTag, isPublishable } from "../release/version.js";

/** Outcomes produced by the reusable latest-release comparison. */
export type ReleaseAvailabilityStatus =
  | "available"
  | "current"
  | "prerelease-ignored"
  | "not-applicable"
  | "unverified";

/** Network resolver that supplied the latest published version. */
export type ReleaseAvailabilityResolver = "npm-view";

/** Typed result consumed by doctor today and safe-idle upgrade prompting later. */
export type ReleaseAvailabilityResult =
  | {
      readonly status: "available" | "current" | "prerelease-ignored";
      readonly installedVersion: string;
      readonly latestVersion: string;
      readonly resolver: ReleaseAvailabilityResolver;
    }
  | {
      readonly status: "not-applicable";
      readonly installedVersion: null;
      readonly latestVersion: string | null;
      readonly resolver: ReleaseAvailabilityResolver;
    }
  | {
      readonly status: "unverified";
      readonly installedVersion: string;
      readonly latestVersion: null;
      readonly resolver: ReleaseAvailabilityResolver;
    };

function normalizePublishableVersion(version: string | null): string | null {
  if (version === null) return null;
  const candidate = version.trim().replace(/^refs\/tags\//, "");
  if (!candidate || !isPublishable(candidate)) return null;
  return candidate.replace(/^v/, "");
}

/**
 * Compare an installed release with a resolver-provided latest release.
 * Stable installs deliberately ignore prerelease candidates even when their
 * numeric core is newer.
 */
export function evaluateReleaseAvailability(
  installed: string,
  latest: string | null,
  resolver: ReleaseAvailabilityResolver = "npm-view",
): ReleaseAvailabilityResult {
  const installedVersion = normalizePublishableVersion(installed);
  const latestVersion = normalizePublishableVersion(latest);
  if (installedVersion === null) {
    return { status: "not-applicable", installedVersion, latestVersion, resolver };
  }
  if (latestVersion === null) {
    return { status: "unverified", installedVersion, latestVersion, resolver };
  }
  if (!isPrereleaseTag(installedVersion) && isPrereleaseTag(latestVersion)) {
    return { status: "prerelease-ignored", installedVersion, latestVersion, resolver };
  }
  const comparison = comparePublishableVersions(installedVersion, latestVersion);
  return {
    status: comparison < 0 ? "available" : "current",
    installedVersion,
    latestVersion,
    resolver,
  };
}
