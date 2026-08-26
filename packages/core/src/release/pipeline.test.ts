import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectionContainmentError } from "../fs/projection-containment.js";
import { prependUpgradeBanner } from "./changelog.js";
import { formatReleaseHelp } from "./flags.js";
import { checkTagAvailable } from "./gh.js";
import { cmdRelease } from "./main.js";
import { emit, runPipeline } from "./pipeline.js";
import { seedReleaseProjectDir } from "./pipeline-fixture.js";
import type { ReleaseConfig, ReleaseSeams } from "./types.js";

describe("cmdRelease", () => {
  it("returns 2 for invalid version", () => {
    const err: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      err.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(cmdRelease(["not-a-version"])).toBe(2);
      expect(err.join("")).toContain("Invalid version");
    } finally {
      process.stderr.write = orig;
    }
  });

  it("prints help on --help", () => {
    const out: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(cmdRelease(["--help"])).toBe(0);
      expect(out.join("")).toBe(formatReleaseHelp());
    } finally {
      process.stdout.write = orig;
    }
  });

  it("returns 2 when version missing", () => {
    expect(cmdRelease(["--dry-run"])).toBe(2);
  });
});

describe("runPipeline dry-run", () => {
  const baseConfig: ReleaseConfig = {
    version: "0.21.0",
    repo: "deftai/directive",
    baseBranch: "master",
    projectRoot: "/tmp/proj",
    dryRun: true,
    skipTag: true,
    skipRelease: true,
    allowDirty: false,
    draft: true,
    skipCi: true,
    skipBuild: false,
    summary: null,
    allowVbriefDrift: true,
    allowCoverageDebtIssue: null,
    allowSkipCiIssue: 716,
  };

  it("emits DRYRUN steps and returns 0", () => {
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    const seams: ReleaseSeams = {
      todayIso: () => "2026-04-28",
      fileExists: (p) => p.endsWith("CHANGELOG.md"),
      readFile: () => `## [Unreleased]\n\n### Added\n`,
      checkActiveCli: () => ({
        ok: false,
        code: 1,
        active: {
          command: "deft",
          path: "C:\\npm\\deft.cmd",
          version: "0.95.0",
          precedence: 0,
          versionSource: "exec",
        },
        candidates: [],
        targetVersion: "0.21.0",
        message: "stale",
        lines: [],
      }),
    };

    try {
      expect(runPipeline(baseConfig, seams)).toBe(0);
      const err = lines.join("");
      expect(err).toContain("DRYRUN");
      expect(err).toContain("SKIP (--skip-tag)");
      expect(err).toContain("pipeline complete");
      // #2022 Phase 1: the Step-5 dry-run label/text is kept byte-identical to
      // the Python oracle (scripts/release.py) for the #1729 release-parity
      // gate; the functional native-TS-task-check rewiring is asserted via the
      // runCi seam in the test below, not via the cosmetic dry-run label.
      expect(err).toContain("Pre-flight CI (task ci:local | fallback task check)");
      expect(err).toContain("CLI drift report (#3753):");
      expect(err).toContain("released: 0.21.0");
      expect(err).toContain("--prefer-online");
      expect(err).toContain("does not run npm i -g");
    } finally {
      process.stderr.write = orig;
    }
  });

  it("Step-5 invokes the native TypeScript task check seam (not ci_local.py)", () => {
    const projectDir = seedReleaseProjectDir();
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    let runCiInvoked = false;
    const config: ReleaseConfig = {
      ...baseConfig,
      projectRoot: projectDir,
      dryRun: false,
      skipCi: false,
      skipBuild: true,
      allowVbriefDrift: true,
      allowCoverageDebtIssue: null,
      allowSkipCiIssue: null,
    };
    const seams: ReleaseSeams = {
      todayIso: () => "2026-04-28",
      spawnText: (_c, a) => {
        if (a.includes("status")) return { status: 0, stdout: "", stderr: "" };
        if (a.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
      checkTagAvailable: () => [true, "ok"],
      runCi: (_root, _debt) => {
        runCiInvoked = true;
        return [true, "ran native TypeScript task check"];
      },
      fileExists: (p) => p.endsWith("CHANGELOG.md") || p.endsWith("ROADMAP.md"),
      readFile: () => `## [Unreleased]\n\n### Added\n`,
      writeFile: () => undefined,
      refreshRoadmap: () => [true, "ok"],
    };
    try {
      expect(runPipeline(config, seams)).toBe(0);
      expect(runCiInvoked).toBe(true);
    } finally {
      process.stderr.write = orig;
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("returns config error when CHANGELOG missing", () => {
    const seams: ReleaseSeams = {
      fileExists: () => false,
    };
    expect(runPipeline(baseConfig, seams)).toBe(2);
  });
});

const itSymlink = it.skipIf(process.platform === "win32");

describe("release markdown containment (#2470)", () => {
  itSymlink(
    "refuses CHANGELOG promotion when CHANGELOG.md is a symlink outside the project",
    () => {
      const projectDir = mkdtempSync(join(tmpdir(), "release-cl-proj-"));
      const escapeTarget = mkdtempSync(join(tmpdir(), "release-cl-escape-"));
      const escapeFile = join(escapeTarget, "stolen-changelog.md");
      try {
        writeFileSync(escapeFile, "victim\n", { encoding: "utf8" });
        symlinkSync(escapeFile, join(projectDir, "CHANGELOG.md"));

        const config: ReleaseConfig = {
          version: "0.21.0",
          repo: "deftai/directive",
          baseBranch: "master",
          projectRoot: projectDir,
          dryRun: false,
          skipTag: true,
          skipRelease: true,
          allowDirty: true,
          draft: true,
          skipCi: true,
          skipBuild: true,
          summary: null,
          allowVbriefDrift: true,
          allowCoverageDebtIssue: null,
          allowSkipCiIssue: 716,
        };
        const seams: ReleaseSeams = {
          todayIso: () => "2026-04-28",
          spawnText: (_c, a) => {
            if (a.includes("status")) return { status: 0, stdout: "", stderr: "" };
            if (a.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
            return { status: 0, stdout: "", stderr: "" };
          },
          checkTagAvailable: () => [true, "ok"],
          fileExists: (p) => p.endsWith("CHANGELOG.md") || p.endsWith("ROADMAP.md"),
          readFile: () => "## [Unreleased]\n\n### Added\n",
        };

        expect(() => runPipeline(config, seams)).toThrow(ProjectionContainmentError);
        expect(readFileSync(escapeFile, { encoding: "utf8" })).toBe("victim\n");
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
        rmSync(escapeTarget, { recursive: true, force: true });
      }
    },
  );
});

describe("emit", () => {
  it("formats step label", () => {
    const chunks: string[] = [];
    const target = { write: (s: string) => chunks.push(s) };
    emit(1, "Test step", "OK", target as unknown as NodeJS.WriteStream);
    expect(chunks[0]).toBe("[1/13] Test step... OK\n");
  });
});

describe("prependUpgradeBanner", () => {
  it("no-ops for consumer repo", () => {
    expect(prependUpgradeBanner("notes", "other/repo", "/root", () => "banner")).toBe("notes");
  });

  it("prepends banner for maintainer repo", () => {
    const out = prependUpgradeBanner("notes", "deftai/directive", "/root", () => "Upgrade me");
    expect(out).toBe("Upgrade me\n\nnotes");
  });

  it("returns notes when banner is whitespace only", () => {
    expect(prependUpgradeBanner("notes", "deftai/directive", "/r", () => "   \n")).toBe("notes");
  });
});

describe("checkTagAvailable", () => {
  it("detects local tag conflict", () => {
    const seams: ReleaseSeams = {
      spawnText: (_cmd, args) => {
        if (args.includes("tag") && args.includes("-l")) {
          return { status: 0, stdout: "v0.21.0\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      whichGh: () => null,
    };
    const [ok, reason] = checkTagAvailable("0.21.0", "deftai/directive", "/proj", seams);
    expect(ok).toBe(false);
    expect(reason).toContain("local tag");
  });
});
