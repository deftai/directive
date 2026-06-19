import { describe, expect, it } from "vitest";
import { createGithubRelease, verifyReleaseDraft } from "./gh.js";
import { checkGitClean, commitReleaseArtifacts, createTag, pushRelease } from "./git.js";
import { runPipeline } from "./pipeline.js";
import { spawnText } from "./spawn.js";
import type { ReleaseConfig, ReleaseSeams } from "./types.js";

const CHANGELOG = `## [Unreleased]\n\n### Added\n- x\n`;

function baseSeams(overrides: ReleaseSeams = {}): ReleaseSeams {
  return {
    spawnText: (_c, a) => {
      if (a.includes("status")) return { status: 0, stdout: "", stderr: "" };
      if (a.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
    checkTagAvailable: () => [true, "ok"],
    checkVbriefLifecycleSync: () => [true, 0, ""],
    fileExists: (p) => /\.(md|toml)$/.test(p),
    readFile: (p) => (p.endsWith("pyproject.toml") ? '[project]\nversion = "0.20.0"\n' : CHANGELOG),
    writeFile: () => undefined,
    runUvLock: () => [true, "uv.lock regenerated"],
    refreshRoadmap: () => [true, "ok"],
    runBuild: () => [true, "ok"],
    todayIso: () => "2026-04-28",
    ...overrides,
  };
}

const baseConfig: ReleaseConfig = {
  version: "0.21.0",
  repo: "deftai/directive",
  baseBranch: "master",
  projectRoot: "/proj",
  dryRun: false,
  skipTag: false,
  skipRelease: false,
  allowDirty: false,
  draft: true,
  skipCi: true,
  skipBuild: false,
  summary: null,
  allowVbriefDrift: true,
};

describe("spawnText", () => {
  it("returns status from spawnSync", () => {
    const r = spawnText("echo", ["hello"], { timeoutMs: 5000 });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("hello");
  });
});

describe("git failure branches", () => {
  it("checkGitClean fails when git errors", () => {
    const [ok] = checkGitClean("/p", {
      spawnText: () => ({ status: 1, stdout: "", stderr: "boom" }),
    });
    expect(ok).toBe(false);
  });

  it("commitReleaseArtifacts fails on git add", () => {
    const seams: ReleaseSeams = {
      spawnText: (_c, a) => {
        if (a.includes("add")) return { status: 1, stdout: "", stderr: "add fail" };
        return { status: 0, stdout: "", stderr: "" };
      },
      fileExists: () => true,
    };
    const [ok] = commitReleaseArtifacts("/proj", "0.21.0", seams);
    expect(ok).toBe(false);
  });

  it("createTag fails on git error", () => {
    const [ok] = createTag("/proj", "0.21.0", {
      spawnText: () => ({ status: 1, stdout: "", stderr: "tag fail" }),
    });
    expect(ok).toBe(false);
  });

  it("pushRelease fails on git error", () => {
    const [ok] = pushRelease("/proj", "0.21.0", "master", {
      spawnText: () => ({ status: 1, stdout: "", stderr: "push fail" }),
    });
    expect(ok).toBe(false);
  });
});

describe("pipeline remaining branches", () => {
  it("fails vbrief config error", () => {
    expect(
      runPipeline(
        { ...baseConfig, allowVbriefDrift: false },
        baseSeams({ checkVbriefLifecycleSync: () => [false, -1, "cfg"] }),
      ),
    ).toBe(2);
  });

  it("fails roadmap refresh", () => {
    expect(runPipeline(baseConfig, baseSeams({ refreshRoadmap: () => [false, "bad"] }))).toBe(1);
  });

  it("fails build step", () => {
    expect(runPipeline(baseConfig, baseSeams({ runBuild: () => [false, "build fail"] }))).toBe(1);
  });

  it("runs tag and push when skip_tag false", () => {
    expect(runPipeline({ ...baseConfig, skipRelease: true }, baseSeams())).toBe(0);
  });

  it("creates github release when skip_release false", () => {
    const seams = baseSeams({
      whichGh: () => "/usr/bin/gh",
      spawnText: (_c, a) => {
        if (a.includes("status")) return { status: 0, stdout: "", stderr: "" };
        if (a.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
        if (a[0] === "release" && a[1] === "view") {
          return { status: 0, stdout: '{"isDraft":true}', stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      sleep: () => undefined,
    });
    expect(runPipeline({ ...baseConfig, skipRelease: false, skipTag: true }, seams)).toBe(0);
  });

  it("fails github release create", () => {
    const seams = baseSeams({
      whichGh: () => "/usr/bin/gh",
      spawnText: (_c, a) => {
        if (a[0] === "release" && a[1] === "create") {
          return { status: 1, stdout: "", stderr: "create failed" };
        }
        if (a.includes("status")) return { status: 0, stdout: "", stderr: "" };
        if (a.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(runPipeline({ ...baseConfig, skipRelease: false, skipTag: true }, seams)).toBe(1);
  });

  it("warns on allow-dirty non-dry-run", () => {
    const seams = baseSeams({
      spawnText: (_c, a) => {
        if (a.includes("status")) return { status: 0, stdout: " M d\n", stderr: "" };
        if (a.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(
      runPipeline({ ...baseConfig, allowDirty: true, dryRun: false, skipRelease: true }, seams),
    ).toBe(0);
  });

  it("fails when commit step fails", () => {
    const config: ReleaseConfig = {
      ...baseConfig,
      skipRelease: true,
      skipBuild: true,
      skipCi: true,
      skipTag: false,
    };
    const seams = baseSeams({
      spawnText: (_c, a) => {
        if (a.includes("status")) return { status: 0, stdout: "", stderr: "" };
        if (a.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
        if (a.includes("commit")) return { status: 1, stdout: "", stderr: "commit err" };
        if (a.includes("diff")) return { status: 1, stdout: "", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
      fileExists: () => true,
    });
    expect(runPipeline(config, seams)).toBe(1);
  });

  it("fails when tag step fails", () => {
    const config: ReleaseConfig = {
      ...baseConfig,
      skipRelease: true,
      skipBuild: true,
      skipCi: true,
    };
    const seams = baseSeams({
      spawnText: (_c, a) => {
        if (a.includes("status")) return { status: 0, stdout: "", stderr: "" };
        if (a.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
        if (a.includes("tag") && a.includes("-a")) {
          return { status: 1, stdout: "", stderr: "tag err" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(runPipeline(config, seams)).toBe(1);
  });

  it("fails when push step fails", () => {
    const config: ReleaseConfig = {
      ...baseConfig,
      skipRelease: true,
      skipBuild: true,
      skipCi: true,
    };
    const seams = baseSeams({
      spawnText: (_c, a) => {
        if (a.includes("status")) return { status: 0, stdout: "", stderr: "" };
        if (a.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
        if (a.includes("push")) return { status: 1, stdout: "", stderr: "push err" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    expect(runPipeline(config, seams)).toBe(1);
  });

  it("skips verify when --no-draft", () => {
    expect(
      runPipeline({ ...baseConfig, draft: false, skipRelease: true, skipTag: true }, baseSeams()),
    ).toBe(0);
  });
});

describe("gh edge cases", () => {
  it("createGithubRelease uses generate-notes when empty", () => {
    let sawGenerate = false;
    const seams: ReleaseSeams = {
      whichGh: () => "/usr/bin/gh",
      spawnText: (_c, a) => {
        if (a.includes("--generate-notes")) sawGenerate = true;
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    const [ok] = createGithubRelease("/p", "0.21.0", "r", "", {}, seams);
    expect(ok).toBe(true);
    expect(sawGenerate).toBe(true);
  });

  it("verifyReleaseDraft handles gh json error", () => {
    const seams: ReleaseSeams = {
      whichGh: () => "/usr/bin/gh",
      spawnText: () => ({ status: 0, stdout: "not-json", stderr: "" }),
      sleep: () => undefined,
    };
    const [ok] = verifyReleaseDraft(
      "/p",
      "0.21.0",
      "r",
      { maxAttempts: 1, sleep: () => undefined },
      seams,
    );
    expect(ok).toBe(true);
  });
});
