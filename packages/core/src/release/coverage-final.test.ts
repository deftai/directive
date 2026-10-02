import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { promoteChangelog } from "./changelog.js";
import { cmdRelease } from "./main.js";
import {
  formatSuiteBoundCoverageDecline,
  runPipeline,
  suiteExpectedToWriteLocalCoverage,
} from "./pipeline.js";
import { paidSkipCiLedgerSeam, seedReleaseProjectDir } from "./pipeline-fixture.js";
import { passReleaseInputs } from "./release-input.js";
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
  const projectRoot = seedReleaseProjectDir(CHANGELOG);
  const config: ReleaseConfig = {
    version: "0.21.0",
    repo: "deftai/directive",
    baseBranch: "master",
    projectRoot,
    dryRun: false,
    skipTag: true,
    skipRelease: true,
    allowDirty: false,
    draft: true,
    skipCi: true,
    skipBuild: true,
    summary: null,
    allowVbriefDrift: true,
    allowCoverageDebtIssue: null,
    allowSkipCiIssue: 716,
  };

  it("writes changelog on happy path", () => {
    const seams: ReleaseSeams = {
      validateReleaseInputs: passReleaseInputs,
      probeSkipCiIncidentLedger: paidSkipCiLedgerSeam,
      spawnText: (_c, a) => {
        if (a.includes("status")) return { status: 0, stdout: "", stderr: "" };
        if (a.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
      checkTagAvailable: () => [true, "ok"],
      fileExists: (p) => p.endsWith("CHANGELOG.md"),
      readFile: () => CHANGELOG,
      writeFile: () => undefined,
      todayIso: () => "2026-04-28",
    };
    expect(runPipeline(config, seams)).toBe(0);
    expect(readFileSync(join(projectRoot, "CHANGELOG.md"), "utf8")).toContain("## [0.21.0]");
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

describe("suite-bound coverage decline diagnostic (#5026 / #5239 F1)", () => {
  it("prints no-coverage branch when hostCoverage is false", () => {
    expect(
      formatSuiteBoundCoverageDecline(null, "task check failed (exit 1; 2 failed tests)", {
        hostCoverage: false,
      }),
    ).toMatch(/not expected to write a local report/);
    expect(
      suiteExpectedToWriteLocalCoverage("task check failed (exit 1; 2 failed tests)", {
        hostCoverage: false,
      }),
    ).toBe(false);
  });

  it("prints missing-after-suite when hostCoverage is true and failed-tests reason", () => {
    expect(
      formatSuiteBoundCoverageDecline(null, "task check failed (exit 1; 2 failed tests)", {
        hostCoverage: true,
      }),
    ).toBe("coverage-final.json missing after suite");
  });

  it("does not rely on parent DEFT_RELEASE_PREFLIGHT when hostCoverage is explicit", () => {
    const prev = process.env.DEFT_RELEASE_PREFLIGHT;
    delete process.env.DEFT_RELEASE_PREFLIGHT;
    try {
      expect(
        formatSuiteBoundCoverageDecline(null, "task check failed (exit 1; 2 failed tests)", {
          hostCoverage: false,
        }),
      ).toMatch(/not expected to write a local report/);
    } finally {
      if (prev === undefined) delete process.env.DEFT_RELEASE_PREFLIGHT;
      else process.env.DEFT_RELEASE_PREFLIGHT = prev;
    }
  });
});
