import { describe, expect, it } from "vitest";
import { cmdRelease } from "./main.js";
import { runPipeline } from "./pipeline.js";
import type { ReleaseSeams } from "./types.js";

const CHANGELOG = `## [Unreleased]\n\n### Added\n- x\n`;

describe("cmdRelease integration", () => {
  it("runs dry-run pipeline end-to-end via seams", () => {
    const err: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string | Uint8Array) => {
      err.push(String(c));
      return true;
    }) as typeof process.stderr.write;

    const seams: ReleaseSeams = {
      todayIso: () => "2026-06-19",
      fileExists: (p) => p.endsWith("CHANGELOG.md"),
      readFile: () => CHANGELOG,
    };

    try {
      const code = cmdRelease(
        [
          "0.21.0",
          "--dry-run",
          "--skip-tag",
          "--skip-release",
          "--repo",
          "deftai/directive",
          "--project-root",
          "/tmp/proj",
          "--allow-vbrief-drift",
          "--skip-ci",
        ],
        seams,
      );
      expect(code).toBe(0);
      expect(err.join("")).toContain("DRYRUN");
    } finally {
      process.stderr.write = origErr;
    }
  });
});

describe("pipeline verify flip failure", () => {
  it("returns violation when draft flip fails", () => {
    const config = {
      version: "0.21.0",
      repo: "deftai/directive",
      baseBranch: "master",
      projectRoot: "/proj",
      dryRun: false,
      skipTag: true,
      skipRelease: false,
      allowDirty: false,
      draft: true,
      skipCi: true,
      skipBuild: true,
      summary: null,
      allowVbriefDrift: true,
    };
    const seams: ReleaseSeams = {
      spawnText: (_c, a) => {
        if (a.includes("status")) return { status: 0, stdout: "", stderr: "" };
        if (a.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
        if (a[0] === "release" && a[1] === "view") {
          return { status: 0, stdout: '{"isDraft":false}', stderr: "" };
        }
        if (a[0] === "release" && a[1] === "edit") {
          return { status: 1, stdout: "", stderr: "edit fail" };
        }
        if (a[0] === "release" && a[1] === "create") {
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      whichGh: () => "/usr/bin/gh",
      checkTagAvailable: () => [true, "ok"],
      fileExists: (p) => p.endsWith("CHANGELOG.md"),
      readFile: () => CHANGELOG,
      writeFile: () => undefined,
      refreshRoadmap: () => [true, "ok"],
      sleep: () => undefined,
      todayIso: () => "2026-04-28",
    };
    expect(runPipeline(config, seams)).toBe(1);
  });
});
