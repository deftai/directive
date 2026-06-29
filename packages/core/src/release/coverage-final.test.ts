import { describe, expect, it } from "vitest";
import { promoteChangelog } from "./changelog.js";
import { cmdRelease } from "./main.js";
import { runPipeline } from "./pipeline.js";
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

  it("writes changelog on happy path", () => {
    const writes: Record<string, string> = {};
    const seams: ReleaseSeams = {
      spawnText: (_c, a) => {
        if (a.includes("status")) return { status: 0, stdout: "", stderr: "" };
        if (a.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
      checkTagAvailable: () => [true, "ok"],
      fileExists: (p) => p.endsWith("CHANGELOG.md"),
      readFile: () => CHANGELOG,
      writeFile: (p, c) => {
        writes[p] = c;
      },
      refreshRoadmap: () => [true, "ROADMAP.md re-rendered"],
      todayIso: () => "2026-04-28",
    };
    expect(runPipeline(config, seams)).toBe(0);
    expect(writes["/proj/CHANGELOG.md"]).toContain("## [0.21.0]");
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
