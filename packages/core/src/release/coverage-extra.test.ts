import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseReleaseFlags } from "./flags.js";
import { checkGitClean, commitReleaseArtifacts } from "./git.js";
import { runPipeline } from "./pipeline.js";
import { syncPyprojectForRelease } from "./pyproject-sync.js";
import { runUvLock } from "./python-bridge.js";
import { defaultWhich, spawnText } from "./spawn.js";
import type { ReleaseConfig, ReleaseSeams } from "./types.js";
import { isPublishable } from "./version.js";

describe("spawn edge branches", () => {
  it("defaultWhich returns path for node", () => {
    expect(defaultWhich("node")).toMatch(/node/);
  });

  it("spawnText handles missing binary", () => {
    expect(spawnText("/nonexistent/binary-xyz", []).status).toBe(2);
  });
});

describe("runUvLock without seams", () => {
  it("skips when no pyproject on disk", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-uvlock-"));
    const [ok, msg] = runUvLock(root);
    expect(ok).toBe(true);
    expect(msg).toContain("skipping uv lock");
  });
});

describe("git commit branches", () => {
  it("commits when cache diff is non-empty", () => {
    const seams: ReleaseSeams = {
      fileExists: () => true,
      spawnText: (_c, a) => {
        if (a.includes("diff")) return { status: 1, stdout: "", stderr: "" };
        if (a.includes("commit")) return { status: 0, stdout: "", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    const [ok, msg] = commitReleaseArtifacts("/proj", "0.21.0", seams);
    expect(ok).toBe(true);
    expect(msg).toContain("committed");
  });

  it("handles no artifacts on disk", () => {
    const [ok, msg] = commitReleaseArtifacts("/proj", "0.21.0", { fileExists: () => false });
    expect(msg).toContain("none exist");
    expect(ok).toBe(true);
  });

  it("returns dirty output when tree has changes", () => {
    const [ok, out] = checkGitClean("/p", {
      spawnText: () => ({ status: 0, stdout: " M file\n", stderr: "" }),
    });
    expect(ok).toBe(false);
    expect(out).toContain("file");
  });

  it("fails when git commit fails", () => {
    const seams: ReleaseSeams = {
      fileExists: () => true,
      spawnText: (_c, a) => {
        if (a.includes("diff")) return { status: 1, stdout: "", stderr: "" };
        if (a.includes("commit")) return { status: 1, stdout: "", stderr: "err" };
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    expect(commitReleaseArtifacts("/proj", "0.21.0", seams)[0]).toBe(false);
  });
});

describe("syncPyprojectForRelease disk path", () => {
  it("reports idempotent pyproject sync", () => {
    const [note, text] = syncPyprojectForRelease(
      "/p",
      "0.1.0",
      { dryRun: false },
      {
        fileExists: () => true,
        readFile: () => '[project]\nversion = "0.1.0"\n',
      },
    );
    expect(note).toContain("already at");
    expect(text).toBeNull();
  });
});

describe("isPublishable", () => {
  it("classifies publishability", () => {
    expect(isPublishable("1.0.0")).toBe(true);
    expect(isPublishable("0.0.0-test.1")).toBe(false);
    expect(isPublishable("bad")).toBe(false);
  });
});

describe("parseReleaseFlags missing value at EOF", () => {
  it("records --repo without value", () => {
    const flags = parseReleaseFlags(["1.0.0", "--repo"]);
    expect(flags.unknown).toContain("--repo (missing value)");
  });
});

describe("pipeline branches extra", () => {
  const CHANGELOG = `## [Unreleased]\n\n### Added\n- item\n`;

  it("runs vbrief sync ok on non-dry-run", () => {
    const config: ReleaseConfig = {
      version: "0.21.0",
      repo: "deftai/directive",
      baseBranch: "master",
      projectRoot: "/proj",
      dryRun: false,
      skipTag: true,
      skipRelease: true,
      allowDirty: false,
      draft: true,
      skipCi: true,
      skipBuild: true,
      summary: null,
      allowVbriefDrift: false,
    };
    const seams: ReleaseSeams = {
      spawnText: (_c, a) => {
        if (a.includes("status")) return { status: 0, stdout: "", stderr: "" };
        if (a.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
      checkTagAvailable: () => [true, "ok"],
      checkVbriefLifecycleSync: () => [true, 0, "no mismatches"],
      fileExists: (p) => p.endsWith("CHANGELOG.md"),
      readFile: () => CHANGELOG,
      writeFile: () => undefined,
      refreshRoadmap: () => [true, "ok"],
      todayIso: () => "2026-04-28",
    };
    expect(runPipeline(config, seams)).toBe(0);
  });

  it("returns violation when runCi fails", () => {
    const config: ReleaseConfig = {
      version: "0.21.0",
      repo: "deftai/directive",
      baseBranch: "master",
      projectRoot: "/proj",
      dryRun: false,
      skipTag: true,
      skipRelease: true,
      allowDirty: false,
      draft: true,
      skipCi: false,
      skipBuild: true,
      summary: null,
      allowVbriefDrift: true,
    };
    const seams: ReleaseSeams = {
      spawnText: (_c, a) => {
        if (a.includes("status")) return { status: 0, stdout: "", stderr: "" };
        if (a.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
      checkTagAvailable: () => [true, "ok"],
      runCi: () => [false, "ci:local failed (exit 1)"],
    };
    expect(runPipeline(config, seams)).toBe(1);
  });
});
