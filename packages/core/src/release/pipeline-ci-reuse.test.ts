import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MERGE_GATE_TASK_CHECK_NAME } from "../pr-wait-mergeable/constants.js";
import { type CiReuseDecision, TYPESCRIPT_BUILD_LINT_CHECK_NAME } from "./ci-reuse.js";
import { runPipeline } from "./pipeline.js";
import { passReleaseInputs } from "./release-input.js";
import type { ReleaseConfig, ReleaseSeams } from "./types.js";

const CHANGELOG = `## [Unreleased]\n\n### Added\n- x\n`;
const TIP = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";

const REUSE: CiReuseDecision = {
  kind: "reuse",
  tipSha: TIP,
  tree: "feedfeedfeedfeedfeedfeedfeedfeedfeedfeed",
  checks: [
    {
      name: TYPESCRIPT_BUILD_LINT_CHECK_NAME,
      status: "completed",
      conclusion: "success",
      url: "https://github.com/deftai/directive/runs/101",
    },
    {
      name: MERGE_GATE_TASK_CHECK_NAME,
      status: "completed",
      conclusion: "success",
      url: "https://github.com/deftai/directive/runs/102",
    },
  ],
};

const LANE = {
  reusable: true,
  reason: "latest attempt in nightly run 777 succeeded",
  runUrl: "https://github.com/deftai/directive/actions/runs/777",
  headSha: TIP,
};

const tempRoots: string[] = [];

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), "release-ci-reuse-"));
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

function config(projectRoot: string, extra: Partial<ReleaseConfig> = {}): ReleaseConfig {
  return {
    version: "0.98.0",
    repo: "deftai/directive",
    baseBranch: "master",
    breakGlass: true,
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
    ...extra,
  };
}

function captureStderr(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    text: () => lines.join(""),
    restore: () => {
      process.stderr.write = orig;
    },
  };
}

interface Calls {
  runCi: number;
  smoke: number;
  evaluate: number;
}

function seams(decision: CiReuseDecision, calls: Calls, smokeOk = true): ReleaseSeams {
  return {
    validateReleaseInputs: passReleaseInputs,
    todayIso: () => "2026-11-20",
    spawnText: (_c, a) => {
      if (a.includes("branch")) return { status: 0, stdout: "master\n", stderr: "" };
      if (a.includes("rev-parse")) return { status: 0, stdout: `${TIP}\n`, stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
    checkTagAvailable: () => [true, "ok"],
    isCi: () => false,
    fileExists: (p) => p.endsWith("CHANGELOG.md") || p.endsWith("ROADMAP.md"),
    readFile: () => CHANGELOG,
    writeFile: () => {},
    evaluateCiReuse: () => {
      calls.evaluate += 1;
      return decision;
    },
    runHostSmoke: () => {
      calls.smoke += 1;
      return smokeOk
        ? [true, "host smoke check passed (build + 4 host test files; no coverage)"]
        : [false, "host smoke check failed at pnpm run build (exit 1)"];
    },
    runCi: () => {
      calls.runCi += 1;
      return [true, "ran native TypeScript task check (host coverage at Step 5)"];
    },
  };
}

describe("release Step 5 CI reuse (#6791)", () => {
  it("reuses CI with no flag, citation or prompt, prints the tip SHA and check-run URLs, and runs only the smoke check", () => {
    const cap = captureStderr();
    const calls: Calls = { runCi: 0, smoke: 0, evaluate: 0 };
    try {
      expect(runPipeline(config(tempProject()), seams(REUSE, calls))).toBe(0);
      const err = cap.text();
      expect(calls).toEqual({ runCi: 0, smoke: 1, evaluate: 1 });
      expect(err).toContain(TIP);
      expect(err).toContain("https://github.com/deftai/directive/runs/101");
      expect(err).toContain("https://github.com/deftai/directive/runs/102");
      expect(err).toMatch(
        /\[5\/\d+\] [^\n]*OK \(CI reused at tip abcdefabcdef; host smoke check passed/,
      );
      expect(err).toMatch(/no host coverage on a reused cut/);
      expect(err).not.toMatch(/--skip-ci|--allow-skip-ci|untested/);
    } finally {
      cap.restore();
    }
  });

  it("prints a changed decision and runs the full local check without a prompt when readiness was reuse", () => {
    const cap = captureStderr();
    const calls: Calls = { runCi: 0, smoke: 0, evaluate: 0 };
    const changed: CiReuseDecision = {
      kind: "full",
      reason: `latest attempt of '${MERGE_GATE_TASK_CHECK_NAME}' on tip ${TIP} is in_progress, not completed`,
      tipSha: TIP,
    };
    try {
      const code = runPipeline(
        config(tempProject(), { ciReuseAtReadiness: "reuse" }),
        seams(changed, calls),
      );
      expect(code).toBe(0);
      const err = cap.text();
      expect(err).toMatch(
        /CI reuse decision changed since readiness: was reuse, now the full local check/,
      );
      expect(err).toMatch(/CI reuse: no \(latest attempt/);
      expect(calls).toEqual({ runCi: 1, smoke: 0, evaluate: 1 });
    } finally {
      cap.restore();
    }
  });

  it("runs the full local check on a different tree and prints no change line without readiness", () => {
    const cap = captureStderr();
    const calls: Calls = { runCi: 0, smoke: 0, evaluate: 0 };
    try {
      const decision: CiReuseDecision = { kind: "full", reason: "HEAD tree differs", tipSha: TIP };
      expect(runPipeline(config(tempProject()), seams(decision, calls))).toBe(0);
      const err = cap.text();
      expect(err).not.toMatch(/changed since readiness/);
      expect(calls.runCi).toBe(1);
      expect(calls.smoke).toBe(0);
    } finally {
      cap.restore();
    }
  });

  it("skips the local check and prints both nightly run URLs when both lanes are reusable (#6849 clause 17)", () => {
    const cap = captureStderr();
    const calls: Calls = { runCi: 0, smoke: 0, evaluate: 0 };
    const withNightly: CiReuseDecision = {
      ...REUSE,
      nightly: {
        reusable: true,
        lanes: [
          {
            ...LANE,
            id: "coverage",
            label: "coverage (Linux)",
            jobName: "Nightly coverage (Linux)",
          },
          {
            ...LANE,
            id: "windows",
            label: "full suite (Windows)",
            jobName: "Nightly full suite (Windows)",
            runUrl: "https://github.com/deftai/directive/actions/runs/778",
          },
        ],
      },
    };
    try {
      expect(runPipeline(config(tempProject()), seams(withNightly, calls))).toBe(0);
      const err = cap.text();
      expect(calls).toEqual({ runCi: 0, smoke: 1, evaluate: 1 });
      expect(err).toContain("https://github.com/deftai/directive/actions/runs/777");
      expect(err).toContain("https://github.com/deftai/directive/actions/runs/778");
      expect(err).not.toMatch(/Windows suite did not run/);
    } finally {
      cap.restore();
    }
  });

  it("prints that the Windows suite did not run when the fallback runs on a non-Windows host (#6849 clause 21)", () => {
    const decision: CiReuseDecision = {
      kind: "full",
      reason: "a nightly lane is not reusable (nightly full suite (Windows): concluded failure)",
      tipSha: TIP,
    };
    for (const [platform, expected] of [
      ["linux", true],
      ["win32", false],
    ] as const) {
      const cap = captureStderr();
      const calls: Calls = { runCi: 0, smoke: 0, evaluate: 0 };
      try {
        const s = { ...seams(decision, calls), hostPlatform: platform };
        expect(runPipeline(config(tempProject()), s)).toBe(0);
        expect(calls.runCi).toBe(1);
        const said = /The Windows suite did not run for this release/.test(cap.text());
        expect(said).toBe(expected);
      } finally {
        cap.restore();
      }
    }
  });

  it("fails Step 5 when the smoke check of a reused cut fails", () => {
    const cap = captureStderr();
    const calls: Calls = { runCi: 0, smoke: 0, evaluate: 0 };
    try {
      expect(runPipeline(config(tempProject()), seams(REUSE, calls, false))).toBe(1);
      expect(cap.text()).toMatch(/FAIL \(CI reused at tip abcdefabcdef; host smoke check failed/);
      expect(calls.runCi).toBe(0);
    } finally {
      cap.restore();
    }
  });

  it("does not evaluate the rule when an injected runCi owns Step 5, or under --skip-ci", () => {
    const cap = captureStderr();
    const calls: Calls = { runCi: 0, smoke: 0, evaluate: 0 };
    try {
      const owned = { ...seams(REUSE, calls) };
      delete (owned as { evaluateCiReuse?: unknown }).evaluateCiReuse;
      expect(runPipeline(config(tempProject()), owned)).toBe(0);
      expect(calls.runCi).toBe(1);
      expect(cap.text()).not.toMatch(/CI reuse:/);
      const skipCalls: Calls = { runCi: 0, smoke: 0, evaluate: 0 };
      expect(runPipeline(config(tempProject(), { skipCi: true }), seams(REUSE, skipCalls))).toBe(0);
      expect(skipCalls.evaluate).toBe(0);
    } finally {
      cap.restore();
    }
  });
});
