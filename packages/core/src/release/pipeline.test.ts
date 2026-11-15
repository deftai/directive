import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prependUpgradeBanner } from "./changelog.js";
import { formatReleaseHelp } from "./flags.js";
import { checkTagAvailable } from "./gh.js";
import { cmdRelease } from "./main.js";
import { emit, releaseRestoreGuidance, runPipeline } from "./pipeline.js";
import { paidSkipCiLedgerSeam, seedReleaseProjectDir } from "./pipeline-fixture.js";
import { passReleaseInputs } from "./release-input.js";
import { spawnText } from "./spawn.js";
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
    const projectDir = seedReleaseProjectDir();
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    const seams: ReleaseSeams = {
      validateReleaseInputs: passReleaseInputs,
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
      expect(runPipeline({ ...baseConfig, projectRoot: projectDir }, seams)).toBe(0);
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
      expect(err).toContain("Prepare release artifacts");
      expect(err).toContain("Write release artifacts");
    } finally {
      process.stderr.write = orig;
      rmSync(projectDir, { recursive: true, force: true });
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
      validateReleaseInputs: passReleaseInputs,
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
    const projectDir = mkdtempSync(join(tmpdir(), "release-missing-cl-"));
    const seams: ReleaseSeams = {
      validateReleaseInputs: passReleaseInputs,
      fileExists: () => false,
    };
    try {
      expect(runPipeline({ ...baseConfig, projectRoot: projectDir }, seams)).toBe(2);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

const itSymlink = it.skipIf(process.platform === "win32");

describe("release markdown containment (#2470)", () => {
  itSymlink("classified Step 5 refusal when CHANGELOG.md is a symlink outside the project", () => {
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
        validateReleaseInputs: passReleaseInputs,
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

      expect(runPipeline(config, seams)).toBe(1);
      expect(readFileSync(escapeFile, { encoding: "utf8" })).toBe("victim\n");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(escapeTarget, { recursive: true, force: true });
    }
  });
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
      validateReleaseInputs: passReleaseInputs,
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

describe("release recovery with changelog fragments (#6315 / #6286 item 6)", () => {
  const CHANGELOG =
    "## [Unreleased]\n\n### Added\n\n- inline (#1)\n\n## [0.20.0] - 2026-04-01\n\n- old\n";
  const FRAGMENTS: Record<string, string> = {
    "20-a.md": "section: Added\n- fragment a (#20)\n",
    "30-b.md": "section: Fixed\n- fragment b (#30)\n",
  };

  function git(root: string, args: string[]): string {
    return execFileSync("git", ["-c", "user.email=ci@test", "-c", "user.name=ci", ...args], {
      cwd: root,
      encoding: "utf8",
    });
  }

  function gitProject(): string {
    const root = mkdtempSync(join(tmpdir(), "release-recover-"));
    writeFileSync(join(root, "CHANGELOG.md"), CHANGELOG);
    writeFileSync(join(root, "ROADMAP.md"), "# Roadmap\n");
    mkdirSync(join(root, "changelog.d"));
    for (const [name, text] of Object.entries(FRAGMENTS)) {
      writeFileSync(join(root, "changelog.d", name), text);
    }
    execFileSync("git", ["init", "-q", "-b", "master"], { cwd: root });
    git(root, ["config", "core.autocrlf", "false"]);
    // Keep the identity in the repo so a run that reaches Step 9 can commit on CI.
    git(root, ["config", "user.email", "ci@test"]);
    git(root, ["config", "user.name", "ci"]);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "init"]);
    return root;
  }

  function config(root: string, overrides: Partial<ReleaseConfig> = {}): ReleaseConfig {
    return {
      version: "0.21.0",
      repo: "deftai/directive",
      baseBranch: "master",
      projectRoot: root,
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
      ...overrides,
    };
  }

  /** Real git for the dirty-tree and branch guards; everything else stubbed. */
  function seams(extra: Partial<ReleaseSeams> = {}): ReleaseSeams {
    return {
      validateReleaseInputs: passReleaseInputs,
      probeSkipCiIncidentLedger: paidSkipCiLedgerSeam,
      consumerHardStops: () => [true, "ok"],
      checkVbriefLifecycleSync: () => [true, 0, "ok"],
      checkTagAvailable: () => [true, "ok"],
      todayIso: () => "2026-04-28",
      spawnText: (cmd, args, options) =>
        cmd === "git" ? spawnText(cmd, args, options) : { status: 0, stdout: "", stderr: "" },
      ...extra,
    };
  }

  function run(cfg: ReleaseConfig, s: ReleaseSeams): { code: number; err: string } {
    const chunks: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string | Uint8Array) => {
      chunks.push(String(c));
      return true;
    }) as typeof process.stderr.write;
    try {
      return { code: runPipeline(cfg, s), err: chunks.join("") };
    } finally {
      process.stderr.write = orig;
    }
  }

  function count(text: string, needle: string): number {
    return text.split(needle).length - 1;
  }

  function expectRecoveryAfterFailure(root: string, failed: { code: number; err: string }): void {
    expect(failed.code).toBe(1);
    expect(failed.err).toContain("restore CHANGELOG.md, ROADMAP.md and changelog.d/ to HEAD");
    expect(failed.err).toContain("--allow-dirty is not a recovery path");

    // Rerun without a restore: the dirty-tree guard refuses.
    const rerun = run(config(root), seams());
    expect(rerun.code).toBe(1);
    expect(rerun.err).toContain("working tree is dirty");
    // Even past that guard, the promoted version heading refuses a second promotion.
    const forced = run(config(root, { allowDirty: true }), seams());
    expect(forced.code).toBe(1);
    expect(forced.err).toContain("already holds a ## [0.21.0] heading");

    // Restore to HEAD, then rerun: each entry once, one version section.
    git(root, [
      "restore",
      "--source=HEAD",
      "--staged",
      "--worktree",
      "--",
      "CHANGELOG.md",
      "ROADMAP.md",
      "changelog.d/",
    ]);
    const again = run(config(root), seams());
    expect(again.code).toBe(0);
    const text = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    expect(count(text, "## [0.21.0]")).toBe(1);
    for (const entry of ["- inline (#1)", "- fragment a (#20)", "- fragment b (#30)"]) {
      expect(count(text, entry)).toBe(1);
    }
    expect(existsSync(join(root, "changelog.d", "20-a.md"))).toBe(false);
  }

  it("a failure after the write and before deletion: restore, then rerun", () => {
    const root = gitProject();
    try {
      let calls = 0;
      const failed = run(
        config(root),
        seams({
          unlinkFragment: () => {
            calls += 1;
            throw new Error("injected unlink failure");
          },
        }),
      );
      expect(calls).toBe(1);
      expect(failed.err).toContain("injected unlink failure");
      expect(existsSync(join(root, "changelog.d", "20-a.md"))).toBe(true);
      expectRecoveryAfterFailure(root, failed);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a failure after deletion and before the commit: restore, then rerun", () => {
    const root = gitProject();
    try {
      const failed = run(
        config(root, { skipBuild: false }),
        seams({ runBuild: () => [false, "injected build failure"] }),
      );
      expect(failed.err).toContain("injected build failure");
      expect(existsSync(join(root, "changelog.d", "20-a.md"))).toBe(false);
      expectRecoveryAfterFailure(root, failed);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("names the restore without changelog.d/ in the command when no fragment was captured", () => {
    expect(releaseRestoreGuidance(0)).toContain("-- CHANGELOG.md ROADMAP.md)");
    expect(releaseRestoreGuidance(2)).toContain("-- CHANGELOG.md ROADMAP.md changelog.d/)");
  });
});
