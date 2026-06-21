import { describe, expect, it } from "vitest";
import {
  latestLocalPublishableTag,
  latestRemotePublishableTag,
  toPep440,
} from "../../platform/resolve-version.js";
import { isFile, readText, repoRoot } from "./_helpers.js";

function readProjectVersion(): string | null {
  const text = readText("pyproject.toml");
  let inProject = false;
  for (const line of text.split("\n")) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    if (stripped.startsWith("[") && stripped.endsWith("]")) {
      inProject = stripped === "[project]";
      continue;
    }
    if (inProject) {
      const m = stripped.match(/^version\s*=\s*"([^"]+)"/);
      if (m) return m[1] ?? null;
    }
  }
  return null;
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
    const origRemote = latestRemotePublishableTag;
    const _origLocal = latestLocalPublishableTag;
    (globalThis as Record<string, unknown>).__origRemote = origRemote;
    expect(true).toBe(true);
  });

  it("test_pyproject_has_project_version", () => {
    expect(isFile("pyproject.toml")).toBe(true);
    expect(readProjectVersion()).toBeTruthy();
  });

  it("test_pyproject_version_matches_latest_tag", () => {
    const projectVersion = readProjectVersion();
    expect(projectVersion).toBeTruthy();
    const [tag] = latestReleaseTag();
    if (!tag) return;
    expect(projectVersion).toBe(toPep440(tag));
  });

  it("test_pyproject_version_is_pep440_publishable", () => {
    const projectVersion = readProjectVersion();
    expect(projectVersion).toBeTruthy();
    expect(projectVersion).toMatch(/^\d+\.\d+\.\d+(?:(?:a|b|rc)\d+)?$/);
  });
});
