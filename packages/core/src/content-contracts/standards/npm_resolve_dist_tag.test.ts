/**
 * #5852 Prefer-A Recut-6 P1/P4: table-driven proof of the committed Resolve
 * script the npm-publish workflow runs from the workflow ref. Synthetic
 * tag-push refs only; no network, no tags, no OIDC.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { releaseDistTag } from "../../release/version.js";

const SCRIPT = fileURLToPath(
  new URL("../../../../../.github/scripts/resolve-npm-dist-tag.mjs", import.meta.url),
);

function resolve(version: string, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, version], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: r.status, out: (r.stdout ?? "").trim(), err: r.stderr ?? "" };
}

/** Mirror of the workflow identity step for a push trigger: refs/tags/vX -> X. */
function versionFromTagRef(ref: string): string {
  expect(ref.startsWith("refs/tags/v")).toBe(true);
  return ref.slice("refs/tags/v".length);
}

const TAG_PUSH_TABLE: ReadonlyArray<readonly [string, string]> = [
  ["refs/tags/v0.129.0", "maintainer"],
  ["refs/tags/v1.0.0", "maintainer"],
  ["refs/tags/v10.20.30", "maintainer"],
  ["refs/tags/v0.129.0-beta.1", "beta"],
  ["refs/tags/v0.129.0-rc.2", "rc"],
  ["refs/tags/v0.129.0-alpha.1", "alpha"],
  ["refs/tags/v1.2.3-1", "next"],
  ["refs/tags/v1.2.3-0.1", "next"],
  ["refs/tags/v1.2.3+build.5", "next"],
  ["refs/tags/v1.2.3-beta-hotfix.1", "beta"],
  ["refs/tags/v1.2.3+build-sha", "next"],
];

describe("resolve-npm-dist-tag.mjs (#5852)", () => {
  for (const [ref, expected] of TAG_PUSH_TABLE) {
    it(`synthetic tag-push ${ref} -> ${expected}`, () => {
      const r = resolve(versionFromTagRef(ref));
      expect(r.status).toBe(0);
      expect(r.out).toBe(expected);
    });
  }

  it("never emits latest for any admitted version", () => {
    for (const [ref] of TAG_PUSH_TABLE) {
      expect(resolve(versionFromTagRef(ref)).out).not.toBe("latest");
    }
  });

  for (const bad of ["1.2.3-latest.1", "1.2.3-LATEST", "1.2.3-latest"]) {
    it(`refuses PRE=latest spelling ${bad}`, () => {
      const r = resolve(bad);
      expect(r.status).toBe(1);
      expect(r.out).toBe("");
      expect(r.err).toMatch(/latest/);
    });
  }

  for (const bad of ["v1.2.3", "1.2", "latest", ""]) {
    it(`refuses non-SemVer '${bad}'`, () => {
      expect(resolve(bad).status).toBe(1);
    });
  }

  it("reads no input: dispatch/env spellings of latest cannot change a stable result", () => {
    const r = resolve("0.129.0", {
      INPUT_DIST_TAG: "latest",
      DIST_TAG: "latest",
      INPUT_ACTION: "promote-latest",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/tags/v0.129.0",
      NPM_CONFIG_TAG: "latest",
    });
    expect(r.out).toBe("maintainer");
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/GITHUB_|INPUT_/);
  });

  it("matches the release CLI channel rule for every publishable release version", () => {
    for (const v of ["0.129.0", "0.129.0-beta.1", "0.129.0-rc.2", "0.129.0-alpha.3"]) {
      expect(resolve(v).out).toBe(releaseDistTag(v));
    }
  });
});
