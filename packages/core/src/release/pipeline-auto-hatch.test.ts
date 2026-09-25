import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPipeline } from "./pipeline.js";
import { passReleaseInputs } from "./release-input.js";
import type { ReleaseConfig, ReleaseSeams } from "./types.js";

const CHANGELOG = `## [Unreleased]\n\n### Added\n- x\n`;

const hairlineTotals = {
  branches: 84.95,
  lines: 86.1,
  functions: 87.0,
  statements: 86.0,
};

const GREEN_COVERAGE_CITE = {
  ok: true as const,
  cite: {
    tipSha: "aaaabbbbccccddddeeeeffffaaaabbbbccccdddd",
    runId: "36086680776",
    checkName: "TypeScript (build + lint + test)",
  },
};

const tempRoots: string[] = [];

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), "release-auto-hatch-"));
  writeFileSync(join(root, "CHANGELOG.md"), CHANGELOG, "utf8");
  writeFileSync(join(root, "ROADMAP.md"), "# Roadmap\n", "utf8");
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function baseConfig(projectRoot: string): ReleaseConfig {
  return {
    version: "0.98.0",
    repo: "deftai/directive",
    baseBranch: "master",
    projectRoot,
    dryRun: false,
    skipTag: true,
    skipRelease: true,
    allowDirty: true,
    draft: true,
    skipCi: false,
    skipBuild: true,
    summary: null,
    allowVbriefDrift: true,
    allowCoverageDebtIssue: null,
    allowSkipCiIssue: null,
  };
}

function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    lines,
    restore: () => {
      process.stderr.write = orig;
    },
  };
}

describe("pipeline Step 5 auto-hatch + suite stamp (#3187)", () => {
  it("auto-files debt and continues without re-running suite on BRANCH_HAIRLINE", () => {
    const cap = captureStderr();
    let runCiCalls = 0;
    let createdTitle = "";
    const files = new Map<string, string>();
    const seams: ReleaseSeams = {
      validateReleaseInputs: passReleaseInputs,
      todayIso: () => "2026-08-07",
      spawnText: (_c, a) => {
        if (a.includes("status")) return { status: 0, stdout: "", stderr: "" };
        if (a.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
        if (a.includes("rev-parse")) {
          return { status: 0, stdout: "aaaabbbbccccddddeeeeffffaaaabbbbccccdddd\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      checkTagAvailable: () => [true, "ok"],
      runCi: () => {
        runCiCalls += 1;
        return [false, "task check failed (exit 1)"];
      },
      readCoverageTotals: () => hairlineTotals,
      listOpenCoverageDebtIssues: () => [],
      createCoverageDebtIssue: (_r, _p, title) => {
        createdTitle = title;
        return 4242;
      },
      fileExists: (p) => p.endsWith("CHANGELOG.md") || p.endsWith("ROADMAP.md") || files.has(p),
      readFile: (p) => files.get(p) ?? CHANGELOG,
      writeFile: (p, c) => {
        files.set(p, c);
      },
      isCi: () => false,
      resolveCoverageOfRecord: () => GREEN_COVERAGE_CITE,
    };

    try {
      expect(runPipeline(baseConfig(tempProject()), seams)).toBe(0);
      expect(runCiCalls).toBe(1);
      expect(createdTitle).toMatch(/^coverage-debt:/);
      const err = cap.lines.join("");
      expect(err).toMatch(/PASS_WITH_DEBT\(#4242\)/);
      expect(err).toMatch(/AUTO-HATCH/);
      expect(err).toMatch(/coverage-of-record gha-run=36086680776/);
    } finally {
      cap.restore();
    }
  });

  it("fails closed when open coverage-debt ledger is non-empty", () => {
    const cap = captureStderr();
    let created = false;
    const seams: ReleaseSeams = {
      validateReleaseInputs: passReleaseInputs,
      todayIso: () => "2026-08-07",
      spawnText: (_c, a) => {
        if (a.includes("status")) return { status: 0, stdout: "", stderr: "" };
        if (a.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
        if (a.includes("rev-parse")) {
          return { status: 0, stdout: "aaaabbbbccccddddeeeeffffaaaabbbbccccdddd\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      checkTagAvailable: () => [true, "ok"],
      runCi: () => [false, "task check failed (exit 1)"],
      readCoverageTotals: () => hairlineTotals,
      listOpenCoverageDebtIssues: () => [3185],
      createCoverageDebtIssue: () => {
        created = true;
        return 1;
      },
      fileExists: (p) => p.endsWith("CHANGELOG.md") || p.endsWith("ROADMAP.md"),
      readFile: () => CHANGELOG,
      writeFile: () => undefined,
      isCi: () => false,
    };

    try {
      expect(runPipeline(baseConfig(tempProject()), seams)).toBe(1);
      expect(created).toBe(false);
      expect(cap.lines.join("")).toMatch(/3185/);
    } finally {
      cap.restore();
    }
  });

  it("fails closed on REAL_FAILURE / UNKNOWN without creating issues", () => {
    const cap = captureStderr();
    let created = false;
    const seams: ReleaseSeams = {
      validateReleaseInputs: passReleaseInputs,
      todayIso: () => "2026-08-07",
      spawnText: (_c, a) => {
        if (a.includes("status")) return { status: 0, stdout: "", stderr: "" };
        if (a.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
        if (a.includes("rev-parse")) {
          return { status: 0, stdout: "aaaabbbbccccddddeeeeffffaaaabbbbccccdddd\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      checkTagAvailable: () => [true, "ok"],
      runCi: () => [false, "task check timed out after 20m (vitest coverage hang)"],
      readCoverageTotals: () => hairlineTotals,
      listOpenCoverageDebtIssues: () => [],
      createCoverageDebtIssue: () => {
        created = true;
        return 1;
      },
      fileExists: (p) => p.endsWith("CHANGELOG.md") || p.endsWith("ROADMAP.md"),
      readFile: () => CHANGELOG,
      writeFile: () => undefined,
      isCi: () => false,
    };

    try {
      expect(runPipeline(baseConfig(tempProject()), seams)).toBe(1);
      expect(created).toBe(false);
      expect(cap.lines.join("")).toMatch(/FAIL/);
    } finally {
      cap.restore();
    }
  });

  it("skips suite on suite stamp hit at same clean HEAD", () => {
    const cap = captureStderr();
    let runCiCalls = 0;
    const sha = "aaaabbbbccccddddeeeeffffaaaabbbbccccdddd";
    const stampPathSuffix = "release-suite-stamp.json";
    const projectRoot = tempProject();
    const stampContent = JSON.stringify({
      schemaVersion: 1,
      headSha: sha,
      suite: "pass",
      debtIssue: null,
      recordedAt: "2026-08-07T00:00:00.000Z",
    });

    const seams: ReleaseSeams = {
      validateReleaseInputs: passReleaseInputs,
      todayIso: () => "2026-08-07",
      spawnText: (_c, a) => {
        if (a.includes("status")) return { status: 0, stdout: "", stderr: "" };
        if (a.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
        if (a.includes("rev-parse")) return { status: 0, stdout: `${sha}\n`, stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
      checkTagAvailable: () => [true, "ok"],
      runCi: () => {
        runCiCalls += 1;
        return [true, "should not run"];
      },
      headSha: () => sha,
      fileExists: (p) => {
        if (p.endsWith("CHANGELOG.md") || p.endsWith("ROADMAP.md")) return true;
        if (p.includes(stampPathSuffix)) return true;
        return false;
      },
      readFile: (p) => {
        if (p.includes(stampPathSuffix)) return stampContent;
        return CHANGELOG;
      },
      writeFile: () => undefined,
      isCi: () => false,
      resolveCoverageOfRecord: () => GREEN_COVERAGE_CITE,
    };

    try {
      expect(runPipeline(baseConfig(projectRoot), seams)).toBe(0);
      expect(runCiCalls).toBe(0);
      const err = cap.lines.join("");
      expect(err).toMatch(/suite stamp hit/);
      expect(err).toMatch(/coverage-of-record gha-run=36086680776/);
    } finally {
      cap.restore();
    }
  });

  it("fail-closes suite stamp hit without tip-SHA GHA coverage-of-record (#5026)", () => {
    const cap = captureStderr();
    let runCiCalls = 0;
    const sha = "aaaabbbbccccddddeeeeffffaaaabbbbccccdddd";
    const stampPathSuffix = "release-suite-stamp.json";
    const projectRoot = tempProject();
    const stampContent = JSON.stringify({
      schemaVersion: 1,
      headSha: sha,
      suite: "pass_with_debt",
      debtIssue: 4242,
      recordedAt: "2026-08-07T00:00:00.000Z",
    });

    const seams: ReleaseSeams = {
      validateReleaseInputs: passReleaseInputs,
      todayIso: () => "2026-08-07",
      spawnText: (_c, a) => {
        if (a.includes("status")) return { status: 0, stdout: "", stderr: "" };
        if (a.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
        if (a.includes("rev-parse")) return { status: 0, stdout: `${sha}\n`, stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
      checkTagAvailable: () => [true, "ok"],
      runCi: () => {
        runCiCalls += 1;
        return [true, "should not run"];
      },
      headSha: () => sha,
      fileExists: (p) => {
        if (p.endsWith("CHANGELOG.md") || p.endsWith("ROADMAP.md")) return true;
        if (p.includes(stampPathSuffix)) return true;
        return false;
      },
      readFile: (p) => {
        if (p.includes(stampPathSuffix)) return stampContent;
        return CHANGELOG;
      },
      writeFile: () => undefined,
      isCi: () => false,
      resolveCoverageOfRecord: () => ({
        ok: false,
        reason: "no green tip-SHA GHA coverage-of-record check on aaaabbbbcccc",
      }),
    };

    try {
      expect(runPipeline(baseConfig(projectRoot), seams)).toBe(1);
      expect(runCiCalls).toBe(0);
      const err = cap.lines.join("");
      expect(err).toMatch(/FAIL/);
      expect(err).toMatch(/coverage-of-record/);
      expect(err).toMatch(/suite stamp hit/);
    } finally {
      cap.restore();
    }
  });

  it("fails closed when ledger probe throws (no empty-ledger re-hatch)", () => {
    const cap = captureStderr();
    let created = false;
    const seams: ReleaseSeams = {
      validateReleaseInputs: passReleaseInputs,
      todayIso: () => "2026-08-07",
      spawnText: (_c, a) => {
        if (a.includes("status")) return { status: 0, stdout: "", stderr: "" };
        if (a.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
        if (a.includes("rev-parse")) {
          return { status: 0, stdout: "aaaabbbbccccddddeeeeffffaaaabbbbccccdddd\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      checkTagAvailable: () => [true, "ok"],
      runCi: () => [false, "task check failed (exit 1)"],
      readCoverageTotals: () => hairlineTotals,
      listOpenCoverageDebtIssues: () => {
        throw new Error("gh rate limited");
      },
      createCoverageDebtIssue: () => {
        created = true;
        return 1;
      },
      fileExists: (p) => p.endsWith("CHANGELOG.md") || p.endsWith("ROADMAP.md"),
      readFile: () => CHANGELOG,
      writeFile: () => undefined,
      isCi: () => false,
    };

    try {
      expect(runPipeline(baseConfig(tempProject()), seams)).toBe(1);
      expect(created).toBe(false);
      expect(cap.lines.join("")).toMatch(/ledger probe failed closed/);
    } finally {
      cap.restore();
    }
  });

  it("does not trust suite stamp under CI", () => {
    const cap = captureStderr();
    let runCiCalls = 0;
    const sha = "aaaabbbbccccddddeeeeffffaaaabbbbccccdddd";
    const stampContent = JSON.stringify({
      schemaVersion: 1,
      headSha: sha,
      suite: "pass",
      debtIssue: null,
      recordedAt: "2026-08-07T00:00:00.000Z",
    });
    const seams: ReleaseSeams = {
      validateReleaseInputs: passReleaseInputs,
      todayIso: () => "2026-08-07",
      spawnText: (_c, a) => {
        if (a.includes("status")) return { status: 0, stdout: "", stderr: "" };
        if (a.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
        if (a.includes("rev-parse")) return { status: 0, stdout: `${sha}\n`, stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
      checkTagAvailable: () => [true, "ok"],
      runCi: () => {
        runCiCalls += 1;
        return [true, "ran suite"];
      },
      headSha: () => sha,
      fileExists: (p) =>
        p.endsWith("CHANGELOG.md") ||
        p.endsWith("ROADMAP.md") ||
        p.includes("release-suite-stamp.json"),
      readFile: (p) => (p.includes("release-suite-stamp.json") ? stampContent : CHANGELOG),
      writeFile: () => undefined,
      isCi: () => true,
    };

    try {
      expect(runPipeline(baseConfig(tempProject()), seams)).toBe(0);
      expect(runCiCalls).toBe(1);
    } finally {
      cap.restore();
    }
  });
});
