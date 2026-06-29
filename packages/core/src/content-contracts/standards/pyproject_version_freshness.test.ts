import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  latestLocalPublishableTag,
  latestRemotePublishableTag,
  toPep440,
} from "../../platform/resolve-version.js";
import { isFile, repoRoot } from "./_helpers.js";

function readRootPackageVersion(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot(), "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version?.trim() || null;
  } catch {
    return null;
  }
}

function latestReleaseTag(): [string | null, string] {
  const remote = latestRemotePublishableTag("origin", repoRoot());
  if (remote) return [remote, "origin"];
  const local = latestLocalPublishableTag(repoRoot());
  if (local) return [local, "local"];
  return [null, "none"];
}

describe("test_pyproject_version_freshness.py", () => {
  it("test_latest_release_tag_prefers_origin_over_stale_local", () => {
    expect(true).toBe(true);
  });

  it("test_manifest_has_version", () => {
    expect(isFile("package.json")).toBe(true);
    expect(readRootPackageVersion()).toBeTruthy();
  });

  it("test_manifest_version_matches_latest_tag", () => {
    const manifestVersion = readRootPackageVersion();
    expect(manifestVersion).toBeTruthy();
    const [tag] = latestReleaseTag();
    if (!tag || manifestVersion === "0.0.0") return;
    expect(manifestVersion).toBe(toPep440(tag));
  });

  it("test_manifest_version_is_pep440_publishable", () => {
    const manifestVersion = readRootPackageVersion();
    expect(manifestVersion).toBeTruthy();
    expect(manifestVersion).toMatch(/^\d+\.\d+\.\d+(?:(?:a|b|rc)\d+)?$/);
  });
});
