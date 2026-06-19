import { describe, expect, it } from "vitest";
import { promoteChangelog } from "./changelog.js";
import { cmdRelease } from "./main.js";
import { runPipeline } from "./pipeline.js";
import { syncPyprojectForRelease } from "./pyproject-sync.js";
import { runUvLock } from "./python-bridge.js";
import { defaultWhich } from "./spawn.js";
import type { ReleaseConfig, ReleaseSeams } from "./types.js";

const CHANGELOG = `## [Unreleased]\n\n### Added\n- item\n`;

describe("spawn helpers", () => {
  it("defaultWhich returns path or null", () => {
    const r = defaultWhich("nonexistent-binary-xyz");
    expect(r === null || typeof r === "string").toBe(true);
  });
});

describe("pipeline write path", () => {
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
    allowVbriefDrift: true,
  };

  it("writes changelog and pyproject on happy path", () => {
    const writes: Record<string, string> = {};
    const seams: ReleaseSeams = {
      spawnText: (_c, a) => {
        if (a.includes("status")) return { status: 0, stdout: "", stderr: "" };
        if (a.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
      checkTagAvailable: () => [true, "ok"],
      fileExists: (p) => p.endsWith("CHANGELOG.md") || p.endsWith("pyproject.toml"),
      readFile: (p) =>
        p.endsWith("pyproject.toml") ? '[project]\nversion = "0.20.0"\n' : CHANGELOG,
      writeFile: (p, c) => {
        writes[p] = c;
      },
      runUvLock: () => [true, "uv.lock regenerated"],
      refreshRoadmap: () => [true, "ROADMAP.md re-rendered"],
      todayIso: () => "2026-04-28",
    };
    expect(runPipeline(config, seams)).toBe(0);
    expect(writes["/proj/CHANGELOG.md"]).toContain("## [0.21.0]");
    expect(writes["/proj/pyproject.toml"]).toContain("0.21.0");
  });

  it("fails when uv lock fails", () => {
    const seams: ReleaseSeams = {
      spawnText: (_c, a) => {
        if (a.includes("status")) return { status: 0, stdout: "", stderr: "" };
        if (a.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
      checkTagAvailable: () => [true, "ok"],
      fileExists: (p) => p.endsWith("CHANGELOG.md") || p.endsWith("pyproject.toml"),
      readFile: (p) =>
        p.endsWith("pyproject.toml") ? '[project]\nversion = "0.20.0"\n' : CHANGELOG,
      writeFile: () => undefined,
      runUvLock: () => [false, "uv lock failed"],
      todayIso: () => "2026-04-28",
    };
    expect(runPipeline(config, seams)).toBe(1);
  });
});

describe("syncPyprojectForRelease errors", () => {
  it("returns FAIL for malformed pyproject", () => {
    const [note] = syncPyprojectForRelease(
      "/p",
      "0.21.0",
      { dryRun: false },
      {
        fileExists: () => true,
        readFile: () => "[tool]\n",
      },
    );
    expect(note).toContain("FAIL");
  });
});

describe("runUvLock with uv present", () => {
  it("fails when uv lock exits non-zero", () => {
    const seams: ReleaseSeams = {
      fileExists: () => true,
      whichUv: () => "/usr/bin/uv",
      spawnText: () => ({ status: 1, stdout: "", stderr: "conflict" }),
    };
    const [ok] = runUvLock("/proj", seams);
    expect(ok).toBe(false);
  });

  it("warns when uv missing", () => {
    const err: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string | Uint8Array) => {
      err.push(String(c));
      return true;
    }) as typeof process.stderr.write;
    try {
      const [ok] = runUvLock("/proj", { fileExists: () => true, whichUv: () => null });
      expect(ok).toBe(true);
      expect(err.join("")).toContain("WARNING");
    } finally {
      process.stderr.write = orig;
    }
  });
});

describe("cmdRelease unknown flags", () => {
  it("returns 2 for unknown args", () => {
    expect(cmdRelease(["--bogus-flag"])).toBe(2);
  });
});

describe("promoteChangelog greenfield footer", () => {
  it("prepends links when footer lacks Unreleased line", () => {
    const text = `## [Unreleased]\n\n### Added\n- x\n`;
    const out = promoteChangelog(text, "0.21.0", "deftai/directive", "2026-01-01");
    expect(out).toContain("[Unreleased]:");
    expect(out).toContain("[0.21.0]:");
  });
});
