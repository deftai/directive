import { describe, expect, it } from "vitest";
import { checkTagAvailable, createGithubRelease, resolveGh, verifyReleaseDraft } from "./gh.js";
import {
  checkGitClean,
  commitReleaseArtifacts,
  createTag,
  currentBranch,
  pushRelease,
  releaseSubprocessEnv,
} from "./git.js";
import { runPipeline } from "./pipeline.js";
import { syncPyprojectForRelease } from "./pyproject-sync.js";
import { runUvLock } from "./python-bridge.js";
import type { ReleaseConfig, ReleaseSeams } from "./types.js";

describe("git helpers", () => {
  const seams: ReleaseSeams = {
    spawnText: (_cmd, args) => {
      if (args.includes("status")) {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args.includes("branch")) {
        return { status: 0, stdout: "master\n", stderr: "" };
      }
      if (args.includes("add")) {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args.includes("diff")) {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args.includes("commit")) {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args.includes("tag")) {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args.includes("push")) {
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    fileExists: (p) => p.includes("CHANGELOG.md"),
  };

  it("checkGitClean returns true for clean tree", () => {
    expect(checkGitClean("/proj", seams)[0]).toBe(true);
  });

  it("currentBranch reads git output", () => {
    expect(currentBranch("/proj", seams)).toBe("master");
  });

  it("commitReleaseArtifacts no-ops when nothing staged", () => {
    const [ok, msg] = commitReleaseArtifacts("/proj", "0.21.0", seams);
    expect(ok).toBe(true);
    expect(msg).toContain("no commit needed");
  });

  it("createTag succeeds", () => {
    const [ok] = createTag("/proj", "0.21.0", seams);
    expect(ok).toBe(true);
  });

  it("pushRelease succeeds", () => {
    const [ok] = pushRelease("/proj", "0.21.0", "master", seams);
    expect(ok).toBe(true);
  });

  it("releaseSubprocessEnv sets bypass flags", () => {
    const env = releaseSubprocessEnv({ FOO: "bar" });
    expect(env.DEFT_ALLOW_DEFAULT_BRANCH_COMMIT).toBe("1");
    expect(env.DEFT_ALLOW_DESTRUCTIVE_GH_VERBS).toBe("1");
    expect(env.FOO).toBe("bar");
  });
});

describe("gh helpers", () => {
  it("resolveGh returns null when missing", () => {
    expect(resolveGh({ whichGh: () => null })).toBeNull();
  });

  it("createGithubRelease fails without gh", () => {
    const [ok, reason] = createGithubRelease(
      "/proj",
      "0.21.0",
      "deftai/directive",
      "notes",
      {},
      { whichGh: () => null },
    );
    expect(ok).toBe(false);
    expect(reason).toContain("not found");
  });

  it("verifyReleaseDraft skips when gh missing", () => {
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string | Uint8Array) => {
      lines.push(String(c));
      return true;
    }) as typeof process.stderr.write;
    try {
      const [ok] = verifyReleaseDraft(
        "/proj",
        "0.21.0",
        "deftai/directive",
        {},
        {
          whichGh: () => null,
        },
      );
      expect(ok).toBe(true);
      expect(lines.join("")).toContain("WARNING");
    } finally {
      process.stderr.write = orig;
    }
  });

  it("verifyReleaseDraft confirms draft state", () => {
    const seams: ReleaseSeams = {
      whichGh: () => "/usr/bin/gh",
      spawnText: () => ({
        status: 0,
        stdout: '{"isDraft": true}',
        stderr: "",
      }),
      sleep: () => undefined,
    };
    const [ok, reason] = verifyReleaseDraft(
      "/proj",
      "0.21.0",
      "deftai/directive",
      { sleep: () => undefined },
      seams,
    );
    expect(ok).toBe(true);
    expect(reason).toContain("verified draft");
  });

  it("verifyReleaseDraft flips public release", () => {
    let calls = 0;
    const seams: ReleaseSeams = {
      whichGh: () => "/usr/bin/gh",
      spawnText: () => {
        calls += 1;
        if (calls === 1) {
          return { status: 0, stdout: '{"isDraft": false}', stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      sleep: () => undefined,
    };
    const [ok, reason] = verifyReleaseDraft(
      "/proj",
      "0.21.0",
      "deftai/directive",
      { sleep: () => undefined },
      seams,
    );
    expect(ok).toBe(true);
    expect(reason).toContain("flipped to draft");
  });
});

describe("syncPyprojectForRelease branches", () => {
  const py = `[project]\nversion = "0.20.0"\n`;

  it("handles non-publishable version", () => {
    const [note] = syncPyprojectForRelease(
      "/p",
      "0.0.0-test.1",
      { dryRun: false },
      {
        fileExists: () => true,
        readFile: () => py,
      },
    );
    expect(note).toContain("non-publishable");
  });

  it("returns new text on happy path", () => {
    const [note, text] = syncPyprojectForRelease(
      "/p",
      "0.21.0",
      { dryRun: false },
      {
        fileExists: () => true,
        readFile: () => py,
      },
    );
    expect(note).toContain("0.21.0");
    expect(text).toContain('version = "0.21.0"');
  });

  it("dry-run returns note without text", () => {
    const [, text] = syncPyprojectForRelease(
      "/p",
      "0.21.0",
      { dryRun: true },
      {
        fileExists: () => true,
        readFile: () => py,
      },
    );
    expect(text).toBeNull();
  });
});

describe("runUvLock", () => {
  it("skips when no pyproject", () => {
    const [ok, msg] = runUvLock("/proj", { fileExists: () => false });
    expect(ok).toBe(true);
    expect(msg).toContain("skipping uv lock");
  });
});

describe("checkTagAvailable branches", () => {
  it("reports remote tag conflict", () => {
    const seams: ReleaseSeams = {
      spawnText: (_c, args) => {
        if (args.includes("tag") && args.includes("-l")) {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args.includes("ls-remote")) {
          return { status: 0, stdout: "abc\trefs/tags/v0.21.0\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      whichGh: () => null,
    };
    const [ok, reason] = checkTagAvailable("0.21.0", "deftai/directive", "/p", seams);
    expect(ok).toBe(false);
    expect(reason).toContain("remote tag");
  });

  it("notes remote unverified when ls-remote fails", () => {
    const seams: ReleaseSeams = {
      spawnText: (_c, args) => {
        if (args.includes("ls-remote")) {
          return { status: 1, stdout: "", stderr: "network down" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      whichGh: () => null,
    };
    const [ok, reason] = checkTagAvailable("0.21.0", "deftai/directive", "/p", seams);
    expect(ok).toBe(true);
    expect(reason).toContain("UNVERIFIED");
  });

  it("detects existing GitHub release", () => {
    const seams: ReleaseSeams = {
      spawnText: (_c, args) => {
        if (args[1] === "release") {
          return { status: 0, stdout: '{"tagName":"v0.21.0"}', stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      whichGh: () => "/usr/bin/gh",
    };
    const [ok] = checkTagAvailable("0.21.0", "deftai/directive", "/p", seams);
    expect(ok).toBe(false);
  });
});

describe("createGithubRelease success", () => {
  it("creates release with notes file", () => {
    const seams: ReleaseSeams = {
      whichGh: () => "/usr/bin/gh",
      spawnText: () => ({ status: 0, stdout: "", stderr: "" }),
    };
    const [ok, reason] = createGithubRelease(
      "/proj",
      "0.21.0",
      "deftai/directive",
      "# Notes\n",
      { draft: true, prerelease: true },
      seams,
    );
    expect(ok).toBe(true);
    expect(reason).toContain("draft");
    expect(reason).toContain("prerelease");
  });
});

describe("verifyReleaseDraft polling", () => {
  it("returns inconclusive after not-found budget", () => {
    const seams: ReleaseSeams = {
      whichGh: () => "/usr/bin/gh",
      spawnText: () => ({ status: 1, stdout: "", stderr: "release not found" }),
      sleep: () => undefined,
    };
    const [ok, reason] = verifyReleaseDraft(
      "/proj",
      "0.21.0",
      "deftai/directive",
      { maxAttempts: 2, interval: 0, sleep: () => undefined },
      seams,
    );
    expect(ok).toBe(true);
    expect(reason).toContain("inconclusive");
  });

  it("disables gate when maxAttempts <= 0", () => {
    const [ok] = verifyReleaseDraft(
      "/p",
      "0.1.0",
      "r",
      { maxAttempts: 0 },
      {
        whichGh: () => "/usr/bin/gh",
      },
    );
    expect(ok).toBe(true);
  });
});

describe("runPipeline additional branches", () => {
  const changelog = `## [Unreleased]\n\n### Added\n- x\n`;

  const base: ReleaseConfig = {
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
    summary: "Hello",
    allowVbriefDrift: false,
  };

  it("runs vbrief drift failure path", () => {
    const seams: ReleaseSeams = {
      spawnText: (_c, a) => {
        if (a.includes("status")) return { status: 0, stdout: "", stderr: "" };
        if (a.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
      checkVbriefLifecycleSync: () => [false, 2, "drift"],
      fileExists: (p) => p.endsWith("CHANGELOG.md"),
      readFile: () => changelog,
    };
    expect(runPipeline(base, seams)).toBe(1);
  });

  it("runs promote failure on bad changelog", () => {
    const seams: ReleaseSeams = {
      spawnText: (_c, a) => {
        if (a.includes("status")) return { status: 0, stdout: "", stderr: "" };
        if (a.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
      checkVbriefLifecycleSync: () => [true, 0, ""],
      checkTagAvailable: () => [true, "ok"],
      fileExists: (p) => p.endsWith("CHANGELOG.md"),
      readFile: () => "no unreleased",
      todayIso: () => "2026-01-01",
    };
    expect(runPipeline({ ...base, allowVbriefDrift: true }, seams)).toBe(2);
  });

  it("accepts allow-dirty warn path", () => {
    const seams: ReleaseSeams = {
      spawnText: (_c, a) => {
        if (a.includes("status")) return { status: 0, stdout: " M x\n", stderr: "" };
        if (a.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
      checkVbriefLifecycleSync: () => [true, 0, ""],
      checkTagAvailable: () => [true, "ok"],
      fileExists: (p) => p.endsWith("CHANGELOG.md"),
      readFile: () => changelog,
      todayIso: () => "2026-01-01",
    };
    expect(
      runPipeline({ ...base, allowDirty: true, allowVbriefDrift: true, dryRun: true }, seams),
    ).toBe(0);
  });
});

describe("runPipeline violation branches", () => {
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

  it("fails on dirty tree", () => {
    const seams: ReleaseSeams = {
      spawnText: (_c, args) => {
        if (args.includes("status")) {
          return { status: 0, stdout: " M dirty\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    expect(runPipeline(config, seams)).toBe(1);
  });

  it("fails on wrong branch", () => {
    const seams: ReleaseSeams = {
      spawnText: (_c, args) => {
        if (args.includes("status")) return { status: 0, stdout: "", stderr: "" };
        if (args.includes("branch")) return { status: 0, stdout: "feature\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    expect(runPipeline(config, seams)).toBe(1);
  });
});
