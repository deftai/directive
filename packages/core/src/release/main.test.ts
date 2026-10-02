import { describe, expect, it } from "vitest";
import { cmdRelease } from "./main.js";
import { runPipeline } from "./pipeline.js";
import { seedReleaseProjectDir } from "./pipeline-fixture.js";
import { passReleaseInputs } from "./release-input.js";
import type { ReleaseSeams } from "./types.js";

const CHANGELOG = `## [Unreleased]\n\n### Added\n- x\n`;

describe("cmdRelease integration", () => {
  it("rejects production --skip-ci without incident citation", () => {
    const err: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string | Uint8Array) => {
      err.push(String(c));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(cmdRelease(["0.21.0", "--skip-ci", "--dry-run"])).toBe(2);
      expect(err.join("")).toContain("--allow-skip-ci");
    } finally {
      process.stderr.write = origErr;
    }
  });

  it("rejects unpaid --allow-skip-ci without distinct override via runPipeline (#5239)", () => {
    const err: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string | Uint8Array) => {
      err.push(String(c));
      return true;
    }) as typeof process.stderr.write;
    const seams: ReleaseSeams = {
      validateReleaseInputs: passReleaseInputs,
      probeSkipCiIncidentLedger: () => ({
        unpaid: [{ issue: 5239, reasons: ["changelog_spent"] }],
      }),
      spawnText: (_c, a) => {
        if (a.includes("status")) return { status: 0, stdout: "", stderr: "" };
        if (a.includes("branch") || a.includes("rev-parse") || a.includes("symbolic-ref")) {
          return { status: 0, stdout: "master\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      checkTagAvailable: () => [true, "ok"],
      checkVbriefLifecycleSync: () => [true, 0, ""],
      fileExists: (p) => p.endsWith("CHANGELOG.md") || p.endsWith("ROADMAP.md"),
      readFile: () => CHANGELOG,
      todayIso: () => "2026-06-19",
    };
    try {
      expect(
        cmdRelease(
          [
            "0.21.0",
            "--skip-ci",
            "--allow-skip-ci=5239",
            "--skip-tag",
            "--skip-release",
            "--allow-dirty",
            "--repo",
            "deftai/directive",
            "--project-root",
            seedReleaseProjectDir(),
            "--allow-vbrief-drift",
          ],
          seams,
        ),
      ).toBe(2);
      expect(err.join("")).toMatch(/unpaid/);
      expect(err.join("")).toMatch(/allow-unpaid-skip-ci=#5239/);
    } finally {
      process.stderr.write = origErr;
    }
  });

  it("skips unpaid ledger probe on dry-run so offline rehearsals are not UNKNOWN-refused (#5239)", () => {
    let probed = false;
    const seams: ReleaseSeams = {
      validateReleaseInputs: passReleaseInputs,
      todayIso: () => "2026-06-19",
      fileExists: (p) => p.endsWith("CHANGELOG.md"),
      readFile: () => CHANGELOG,
      probeSkipCiIncidentLedger: () => {
        probed = true;
        return { unpaid: [{ issue: 5239, reasons: ["open_or_unknown"] }] };
      },
    };
    const code = cmdRelease(
      [
        "0.21.0",
        "--dry-run",
        "--skip-tag",
        "--skip-release",
        "--repo",
        "deftai/directive",
        "--project-root",
        seedReleaseProjectDir(),
        "--allow-vbrief-drift",
        "--skip-ci",
        "--allow-skip-ci=5239",
      ],
      seams,
    );
    expect(probed).toBe(false);
    expect(code).toBe(0);
  });

  it("runs dry-run pipeline end-to-end via seams", () => {
    const err: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string | Uint8Array) => {
      err.push(String(c));
      return true;
    }) as typeof process.stderr.write;

    const seams: ReleaseSeams = {
      validateReleaseInputs: passReleaseInputs,
      todayIso: () => "2026-06-19",
      fileExists: (p) => p.endsWith("CHANGELOG.md"),
      readFile: () => CHANGELOG,
      // Avoid live gh unpaid probe on fixture citation (#5239).
      probeSkipCiIncidentLedger: () => ({ unpaid: [] }),
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
          seedReleaseProjectDir(),
          "--allow-vbrief-drift",
          "--skip-ci",
          "--allow-skip-ci=716",
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
      projectRoot: seedReleaseProjectDir(CHANGELOG),
      dryRun: false,
      skipTag: true,
      skipRelease: false,
      allowDirty: false,
      draft: true,
      skipCi: true,
      skipBuild: true,
      summary: null,
      allowVbriefDrift: true,
      allowCoverageDebtIssue: null,
      allowSkipCiIssue: 716,
    };
    const seams: ReleaseSeams = {
      validateReleaseInputs: passReleaseInputs,
      // Paid citation for this fixture — avoid live unpaid probe (#5239).
      probeSkipCiIncidentLedger: () => ({ unpaid: [] }),
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
      sleep: () => undefined,
      todayIso: () => "2026-04-28",
    };
    expect(runPipeline(config, seams)).toBe(1);
  });
});
