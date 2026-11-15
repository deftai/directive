import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { guardChangelogReadSafety, guardFragmentReadSafety } from "./changelog-read-safety.js";
import { EXIT_CONFIG_ERROR, EXIT_VIOLATION } from "./constants.js";
import { runPipeline } from "./pipeline.js";
import { passReleaseInputs } from "./release-input.js";
import type { ReleaseConfig, ReleaseSeams } from "./types.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rel-cl-safety-"));
  roots.push(root);
  return root;
}

const itPosix = it.skipIf(process.platform === "win32");

function baseConfig(root: string, overrides: Partial<ReleaseConfig> = {}): ReleaseConfig {
  return {
    version: "0.21.0",
    repo: "deftai/directive",
    baseBranch: "master",
    projectRoot: root,
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
    ...overrides,
  };
}

function seams(runCi?: ReleaseSeams["runCi"]): ReleaseSeams {
  return {
    validateReleaseInputs: passReleaseInputs,
    todayIso: () => "2026-04-28",
    spawnText: (_c, a) => {
      if (a.includes("status")) return { status: 0, stdout: "", stderr: "" };
      if (a.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
    checkTagAvailable: () => [true, "ok"],
    runCi,
  };
}

function capture(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((c: string | Uint8Array) => {
    chunks.push(String(c));
    return true;
  }) as typeof process.stderr.write;
  return {
    text: () => chunks.join(""),
    restore: () => {
      process.stderr.write = orig;
    },
  };
}

describe("guardChangelogReadSafety", () => {
  it("returns config 2 when CHANGELOG.md is missing", () => {
    const root = tempRoot();
    const result = guardChangelogReadSafety(root);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.exitCode).toBe(EXIT_CONFIG_ERROR);
    expect(result.code).toBe("missing");
  });

  it("accepts a regular CHANGELOG.md", () => {
    const root = tempRoot();
    writeFileSync(join(root, "CHANGELOG.md"), "## [Unreleased]\n\n");
    expect(guardChangelogReadSafety(root)).toEqual({ ok: true });
  });

  it("refuses a directory CHANGELOG.md with policy 1", () => {
    const root = tempRoot();
    mkdirSync(join(root, "CHANGELOG.md"));
    const result = guardChangelogReadSafety(root);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.exitCode).toBe(EXIT_VIOLATION);
    expect(result.code).toBe("directory");
  });

  itPosix("refuses a leaf symlink CHANGELOG.md with policy 1", () => {
    const root = tempRoot();
    const target = join(root, "outside.md");
    writeFileSync(target, "x\n");
    symlinkSync(target, join(root, "CHANGELOG.md"));
    const result = guardChangelogReadSafety(root);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.exitCode).toBe(EXIT_VIOLATION);
    expect(result.code).toBe("symlink");
  });
});

describe("runPipeline Step 5 CHANGELOG guard (#4318)", () => {
  it("classified Step 5 return on a directory node without injecting runCi", () => {
    const root = tempRoot();
    mkdirSync(join(root, "CHANGELOG.md"));
    writeFileSync(join(root, "ROADMAP.md"), "# Roadmap\n");
    let runCiCalls = 0;
    const cap = capture();
    try {
      const rc = runPipeline(
        baseConfig(root, { skipCi: false }),
        seams(() => {
          runCiCalls += 1;
          return [true, "ci"];
        }),
      );
      expect(rc).toBe(EXIT_VIOLATION);
      expect(runCiCalls).toBe(0);
      expect(cap.text()).toMatch(/\[5\/13\].*FAIL/);
      expect(cap.text()).toContain("directory");
    } finally {
      cap.restore();
    }
  });

  it("missing CHANGELOG stays code 2 on dry-run and skip-ci", () => {
    const root = tempRoot();
    expect(runPipeline(baseConfig(root, { dryRun: true, skipCi: true }), seams())).toBe(
      EXIT_CONFIG_ERROR,
    );
    expect(runPipeline(baseConfig(root, { dryRun: false, skipCi: true }), seams())).toBe(
      EXIT_CONFIG_ERROR,
    );
  });

  it("directory CHANGELOG is refused on dry-run and skip-ci", () => {
    const root = tempRoot();
    mkdirSync(join(root, "CHANGELOG.md"));
    expect(runPipeline(baseConfig(root, { dryRun: true }), seams())).toBe(EXIT_VIOLATION);
    expect(runPipeline(baseConfig(root, { skipCi: true }), seams())).toBe(EXIT_VIOLATION);
  });
});

describe("guardFragmentReadSafety (#6315)", () => {
  it("accepts a regular fragment file", () => {
    const root = tempRoot();
    mkdirSync(join(root, "changelog.d"));
    writeFileSync(join(root, "changelog.d", "20-a.md"), "section: Added\n- a (#20)\n");
    expect(guardFragmentReadSafety(root, "changelog.d/20-a.md")).toEqual({ ok: true });
  });

  it("refuses a missing fragment", () => {
    const root = tempRoot();
    mkdirSync(join(root, "changelog.d"));
    const result = guardFragmentReadSafety(root, "changelog.d/20-gone.md");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exitCode).toBe(EXIT_VIOLATION);
      expect(result.message).toContain("changelog.d/20-gone.md");
    }
  });

  it("refuses a directory in place of a fragment", () => {
    const root = tempRoot();
    mkdirSync(join(root, "changelog.d", "20-dir.md"), { recursive: true });
    const result = guardFragmentReadSafety(root, "changelog.d/20-dir.md");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("directory");
  });

  itPosix("refuses a fragment under a symlinked changelog.d", () => {
    const root = tempRoot();
    const outside = tempRoot();
    writeFileSync(join(outside, "20-a.md"), "section: Added\n- a (#20)\n");
    symlinkSync(outside, join(root, "changelog.d"));
    const result = guardFragmentReadSafety(root, "changelog.d/20-a.md");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("symlink");
  });
});
