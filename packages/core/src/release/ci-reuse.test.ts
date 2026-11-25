import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isPidRunning,
  type SupervisedGateResult,
  superviseTimedChild,
  type TimedChildPlan,
} from "../check/suite-gate-supervisor.js";
import { DIRECTIVE_GITIGNORE_LINES } from "../install-health/owned-paths.js";
import type { CheckRunRecord } from "../pr-merge-readiness/gh.js";
import { MERGE_GATE_TASK_CHECK_NAME } from "../pr-wait-mergeable/constants.js";
import { sanitizeTsLaneEnv } from "../ts-check-lane/run-lane.js";
import {
  applyNightlyConjunct,
  checkRunUrl,
  classifyReleaseInputCleanliness,
  decideCiReuseFromRuns,
  describeSmokeFailure,
  evaluateCiReuse,
  formatCiReuseChange,
  formatCiReuseDecision,
  RELEASE_CI_REUSE_REQUIRED_CHECKS,
  RELEASE_HOST_SMOKE_TEST_FILES,
  RELEASE_SESSION_SCRATCH_DIRECTIVE_DIR,
  RELEASE_SESSION_SCRATCH_GENERATION,
  runHostSmokeCheck,
  runSmokeCommand,
  selectLatestCheckRun,
  smokeSpawnPlan,
  TYPESCRIPT_BUILD_LINT_CHECK_NAME,
} from "./ci-reuse.js";
import { RELEASE_CHECK_TIMEOUT_MS } from "./constants.js";
import {
  decideNightlyReuse,
  NIGHTLY_COVERAGE_LANE_NAME,
  NIGHTLY_WINDOWS_LANE_NAME,
} from "./nightly-reuse.js";
import type { ReleaseSeams } from "./types.js";

const REPO = "deftai/directive";
const TIP = "1111111111111111111111111111111111111111";
const TREE = "2222222222222222222222222222222222222222";
const OTHER_TREE = "3333333333333333333333333333333333333333";

function run(
  name: string,
  runId: number,
  status = "completed",
  conclusion = "success",
): CheckRunRecord {
  return { name, status, conclusion, runId, created_at: null, started_at: null };
}

const GREEN: CheckRunRecord[] = [
  run(TYPESCRIPT_BUILD_LINT_CHECK_NAME, 10),
  run(MERGE_GATE_TASK_CHECK_NAME, 11),
];

function checkRunsBody(runs: readonly CheckRunRecord[]): string {
  return JSON.stringify({
    total_count: runs.length,
    check_runs: runs.map((r) => ({
      id: r.runId,
      name: r.name,
      status: r.status,
      conclusion: r.conclusion === "none" ? null : r.conclusion,
    })),
  });
}

function gitSeams(
  options: { dirty?: boolean; fetchFails?: boolean; headTree?: string } = {},
): ReleaseSeams {
  return {
    spawnText: (_cmd, args) => {
      const a = args.join(" ");
      if (a.includes("status --porcelain")) {
        return { status: 0, stdout: options.dirty ? " M x.ts\n" : "", stderr: "" };
      }
      if (a.includes("fetch origin")) {
        return options.fetchFails
          ? { status: 1, stdout: "", stderr: "no network" }
          : { status: 0, stdout: "", stderr: "" };
      }
      if (a.endsWith("rev-parse HEAD^{tree}")) {
        return { status: 0, stdout: `${options.headTree ?? TREE}\n`, stderr: "" };
      }
      if (a.endsWith("rev-parse origin/master^{tree}")) {
        return { status: 0, stdout: `${TREE}\n`, stderr: "" };
      }
      if (a.endsWith("rev-parse origin/master")) {
        return { status: 0, stdout: `${TIP}\n`, stderr: "" };
      }
      return { status: 1, stdout: "", stderr: `unexpected git ${a}` };
    },
  };
}

/** #6849: nightly runs on TREE; `windows` sets the Windows lane's latest conclusion. */
function nightlyBodies(windows = "success"): { runs: string; jobs: string } {
  return {
    runs: JSON.stringify({
      workflow_runs: [
        {
          id: 900,
          head_sha: TIP,
          head_commit: { tree_id: TREE },
          run_attempt: 1,
          html_url: `https://github.com/${REPO}/actions/runs/900`,
        },
      ],
    }),
    jobs: JSON.stringify({
      jobs: [
        { id: 1, name: NIGHTLY_COVERAGE_LANE_NAME, status: "completed", conclusion: "success" },
        { id: 2, name: NIGHTLY_WINDOWS_LANE_NAME, status: "completed", conclusion: windows },
      ],
    }),
  };
}

function ghReturning(runs: readonly CheckRunRecord[] | null, nightlyWindows = "success") {
  const calls: string[] = [];
  const nightly = nightlyBodies(nightlyWindows);
  const runGh = (cmd: readonly string[]) => {
    const joined = cmd.join(" ");
    calls.push(joined);
    if (joined.includes("/actions/workflows/nightly.yml/runs")) {
      return { returncode: 0, stdout: nightly.runs, stderr: "" };
    }
    if (joined.includes("/actions/runs/900/jobs")) {
      return { returncode: 0, stdout: nightly.jobs, stderr: "" };
    }
    if (runs === null) return { returncode: 1, stdout: "", stderr: "HTTP 502" };
    return { returncode: 0, stdout: checkRunsBody(runs), stderr: "" };
  };
  return { runGh, calls };
}

describe("selectLatestCheckRun (#6791)", () => {
  it("picks the run with the larger id, so a re-run wins over an older success", () => {
    const latest = selectLatestCheckRun(
      [
        run(MERGE_GATE_TASK_CHECK_NAME, 5),
        run(MERGE_GATE_TASK_CHECK_NAME, 9, "in_progress", "none"),
      ],
      MERGE_GATE_TASK_CHECK_NAME,
    );
    expect(latest?.runId).toBe(9);
  });

  it("falls back to created_at when ids are absent, and returns null when the name is absent", () => {
    const older = {
      ...run(MERGE_GATE_TASK_CHECK_NAME, 1),
      runId: null,
      created_at: "2026-11-20T10:00:00Z",
    };
    const newer = {
      ...run(MERGE_GATE_TASK_CHECK_NAME, 2, "completed", "failure"),
      runId: null,
      created_at: "2026-11-20T11:00:00Z",
    };
    expect(selectLatestCheckRun([newer, older], MERGE_GATE_TASK_CHECK_NAME)?.conclusion).toBe(
      "failure",
    );
    expect(selectLatestCheckRun([older], TYPESCRIPT_BUILD_LINT_CHECK_NAME)).toBeNull();
  });
});

describe("decideCiReuseFromRuns (#6791)", () => {
  it("reuses when the latest attempt of each required check succeeded", () => {
    const decision = decideCiReuseFromRuns(REPO, TIP, TREE, GREEN);
    expect(decision.kind).toBe("reuse");
    if (decision.kind !== "reuse") return;
    expect(decision.checks.map((c) => c.name)).toEqual([...RELEASE_CI_REUSE_REQUIRED_CHECKS]);
    expect(decision.checks[0]?.url).toBe(`https://github.com/${REPO}/runs/10`);
  });

  it.each([
    ["missing", [run(TYPESCRIPT_BUILD_LINT_CHECK_NAME, 10)], /missing/],
    [
      "pending",
      [...GREEN, run(MERGE_GATE_TASK_CHECK_NAME, 12, "queued", "none")],
      /is queued, not completed/,
    ],
    [
      "re-running",
      [...GREEN, run(TYPESCRIPT_BUILD_LINT_CHECK_NAME, 13, "in_progress", "none")],
      /is in_progress, not completed/,
    ],
    [
      "failed",
      [...GREEN, run(MERGE_GATE_TASK_CHECK_NAME, 14, "completed", "failure")],
      /concluded failure/,
    ],
  ])("runs the full check when the latest attempt is %s, even after an older success", (_label, runs, reason) => {
    const decision = decideCiReuseFromRuns(REPO, TIP, TREE, runs);
    expect(decision.kind).toBe("full");
    if (decision.kind === "full") expect(decision.reason).toMatch(reason);
  });
});

describe("evaluateCiReuse (#6791)", () => {
  it("reuses on an identical clean tree with green latest checks on the fetched tip", () => {
    const gh = ghReturning(GREEN);
    const decision = evaluateCiReuse("/repo", REPO, "master", gitSeams(), {
      runGh: gh.runGh,
      env: {},
    });
    expect(decision.kind).toBe("reuse");
    if (decision.kind === "reuse") expect(decision.tipSha).toBe(TIP);
    expect(gh.calls.join("\n")).toContain(`commits/${TIP}/check-runs`);
  });

  it("runs the full check when the tree differs, without reading check runs", () => {
    const gh = ghReturning(GREEN);
    const decision = evaluateCiReuse("/repo", REPO, "master", gitSeams({ headTree: OTHER_TREE }), {
      runGh: gh.runGh,
      env: {},
    });
    expect(decision.kind).toBe("full");
    if (decision.kind === "full")
      expect(decision.reason).toMatch(/differs from the origin\/master tip tree/);
    expect(gh.calls).toHaveLength(0);
  });

  it("runs the full check on a matching tree with a failed latest check", () => {
    const gh = ghReturning([...GREEN, run(MERGE_GATE_TASK_CHECK_NAME, 20, "completed", "failure")]);
    const decision = evaluateCiReuse("/repo", REPO, "master", gitSeams(), {
      runGh: gh.runGh,
      env: {},
    });
    expect(decision.kind).toBe("full");
  });

  it.each([
    ["a dirty tree", gitSeams({ dirty: true }), GREEN, {}, /not clean/],
    ["a failed fetch", gitSeams({ fetchFails: true }), GREEN, {}, /git fetch origin master failed/],
    ["an unreadable check-runs API", gitSeams(), null, {}, /unreadable/],
    ["DEFT_NO_NETWORK=1", gitSeams(), GREEN, { DEFT_NO_NETWORK: "1" }, /DEFT_NO_NETWORK/],
  ] as const)("returns a full-run decision, not a throw, on %s", (_label, seams, runs, env, reason) => {
    const gh = ghReturning(runs);
    const decision = evaluateCiReuse("/repo", REPO, "master", seams, { runGh: gh.runGh, env });
    expect(decision.kind).toBe("full");
    if (decision.kind === "full") expect(decision.reason).toMatch(reason);
  });

  it("admits tip-green reuse without a hard nightly conjunct and still reads lanes (#7328)", () => {
    const gh = ghReturning(GREEN, "failure");
    const decision = evaluateCiReuse("/repo", REPO, "master", gitSeams(), {
      runGh: gh.runGh,
      env: {},
    });
    expect(decision.kind).toBe("reuse");
    if (decision.kind === "reuse") {
      expect(decision.nightly?.reusable).toBe(false);
      expect(decision.nightly?.lanes[0]?.reusable).toBe(true);
    }
    const trees: string[] = [];
    const seamed = evaluateCiReuse("/repo", REPO, "master", gitSeams(), {
      runGh: ghReturning(GREEN).runGh,
      env: {},
      evaluateNightly: (tree) => {
        trees.push(tree);
        return decideNightlyReuse([], tree, () => ({ jobs: [] }));
      },
    });
    expect(trees).toEqual([TREE]);
    expect(seamed.kind).toBe("reuse");
    if (seamed.kind === "reuse") expect(seamed.nightly?.reusable).toBe(false);
  });

  it("returns a full-run decision when git rev-parse fails", () => {
    const seams: ReleaseSeams = {
      spawnText: (_c, args) =>
        args.includes("rev-parse")
          ? { status: 128, stdout: "", stderr: "bad ref" }
          : { status: 0, stdout: "", stderr: "" },
    };
    const decision = evaluateCiReuse("/repo", REPO, "master", seams, { env: {} });
    expect(decision.kind).toBe("full");
  });
});

describe("formatting (#6791)", () => {
  it("prints the tip SHA, check-run URLs and the no-host-coverage note on reuse", () => {
    const decision = decideCiReuseFromRuns(REPO, TIP, TREE, GREEN);
    const text = formatCiReuseDecision(decision).join("\n");
    expect(text).toContain(TIP);
    expect(text).toContain(`https://github.com/${REPO}/runs/10`);
    expect(text).toContain(`https://github.com/${REPO}/runs/11`);
    expect(text).toMatch(/runs no host coverage; only the short host smoke check runs/);
  });

  it("prints the reason on a full-run decision and a missing URL as such", () => {
    expect(formatCiReuseDecision({ kind: "full", reason: "x", tipSha: null })[0]).toBe(
      "CI reuse: no (x); running the full local check",
    );
    const noId = decideCiReuseFromRuns(REPO, TIP, TREE, [
      { ...run(TYPESCRIPT_BUILD_LINT_CHECK_NAME, 1), runId: null },
      run(MERGE_GATE_TASK_CHECK_NAME, 2),
    ]);
    expect(formatCiReuseDecision(noId).join("\n")).toContain("(no check-run URL)");
    expect(checkRunUrl(REPO, undefined)).toBeNull();
  });

  it("prints both nightly run URLs on reuse and the lanes on a full decision (#6849 clause 17)", () => {
    const green = decideNightlyReuse(
      [{ id: 900, headSha: TIP, treeId: TREE, runAttempt: 1, htmlUrl: "https://x/runs/900" }],
      TREE,
      () => ({
        jobs: [
          {
            id: 1,
            name: NIGHTLY_COVERAGE_LANE_NAME,
            status: "completed",
            conclusion: "success",
            runAttempt: 1,
          },
          {
            id: 2,
            name: NIGHTLY_WINDOWS_LANE_NAME,
            status: "completed",
            conclusion: "success",
            runAttempt: 1,
          },
        ],
      }),
    );
    const reuse = applyNightlyConjunct(decideCiReuseFromRuns(REPO, TIP, TREE, GREEN), green);
    expect(reuse.kind).toBe("reuse");
    const text = formatCiReuseDecision(reuse).join("\n");
    expect(text).toContain("Nightly coverage (Linux): reusable");
    expect(text).toContain("Nightly full suite (Windows): reusable");
    expect(text.match(/https:\/\/x\/runs\/900/g)).toHaveLength(2);
    expect(text).toMatch(/lanes ran on this tree instead/);
    const red = decideNightlyReuse([], TREE, () => ({ jobs: [] }));
    const blocked = applyNightlyConjunct(decideCiReuseFromRuns(REPO, TIP, TREE, GREEN), red);
    expect(blocked.kind).toBe("reuse");
    const blockedText = formatCiReuseDecision(blocked).join("\n");
    expect(blockedText).toContain("Nightly coverage (Linux): not reusable");
    expect(blockedText).toMatch(/tip-green smoke-only reuse continues/);
    expect(blockedText).not.toMatch(/lanes ran on this tree instead/);
    const alreadyFull = applyNightlyConjunct({ kind: "full", reason: "x", tipSha: null }, green);
    expect(alreadyFull).toMatchObject({ kind: "full", reason: "x", nightly: green });
  });

  it("prints a changed decision only when it differs from readiness", () => {
    const reuse = decideCiReuseFromRuns(REPO, TIP, TREE, GREEN);
    const fullRun = { kind: "full" as const, reason: "latest attempt failed", tipSha: TIP };
    expect(formatCiReuseChange(null, fullRun)).toBeNull();
    expect(formatCiReuseChange("full", fullRun)).toBeNull();
    expect(formatCiReuseChange("reuse", fullRun)).toMatch(/was reuse, now the full local check/);
    expect(formatCiReuseChange("full", reuse)).toMatch(/now reuse/);
  });
});

describe("classifyReleaseInputCleanliness (#7328)", () => {
  const start = DIRECTIVE_GITIGNORE_LINES.indexOf("!.deft/plan-sequence.json");
  const end = DIRECTIVE_GITIGNORE_LINES.indexOf(".deft/directive/wiring-ready.*.json");
  const memberLines = DIRECTIVE_GITIGNORE_LINES.slice(start, end + 1);
  const memberDiff = [
    "diff --git a/.gitignore b/.gitignore",
    "--- a/.gitignore",
    "+++ b/.gitignore",
    "@@ -1,0 +1,21 @@",
    ...memberLines.map((line) => `+${line}`),
    "",
  ].join("\n");

  it("admits the observed 21-line DIRECTIVE_GITIGNORE_LINES delta plus named ?? scratch", () => {
    const porcelain = [
      " M .gitignore",
      `?? ${RELEASE_SESSION_SCRATCH_GENERATION}`,
      `?? ${RELEASE_SESSION_SCRATCH_DIRECTIVE_DIR}`,
      "",
    ].join("\n");
    const decision = classifyReleaseInputCleanliness(
      "/repo",
      {},
      {
        porcelain: () => porcelain,
        stagedGitignoreDiff: () => "",
        worktreeGitignoreDiff: () => memberDiff,
        headGitignore: () => "node_modules/\n",
        worktreeGitignore: () => `node_modules/\n${memberLines.join("\n")}\n`,
        allUntracked: () => [
          RELEASE_SESSION_SCRATCH_GENERATION,
          `${RELEASE_SESSION_SCRATCH_DIRECTIVE_DIR}data-schema.json`,
        ],
        isIgnoredBy: () => false,
      },
    );
    expect(decision.kind).toBe("session-scratch-only");
    if (decision.kind === "session-scratch-only") {
      expect(decision.detail).toContain(".gitignore");
      expect(decision.detail).toContain(RELEASE_SESSION_SCRATCH_GENERATION);
      expect(decision.detail).toContain(RELEASE_SESSION_SCRATCH_DIRECTIVE_DIR);
    }
  });

  it("refuses when worktree .gitignore diff command fails", () => {
    const porcelain = [
      " M .gitignore",
      `?? ${RELEASE_SESSION_SCRATCH_GENERATION}`,
      "",
    ].join("\n");
    const decision = classifyReleaseInputCleanliness(
      "/repo",
      {
        spawnText: (_cmd, args) => {
          const joined = args.join(" ");
          if (joined.includes("status --porcelain")) {
            return { status: 0, stdout: porcelain, stderr: "" };
          }
          if (joined.includes("diff --cached") && joined.includes(".gitignore")) {
            return { status: 0, stdout: "", stderr: "" };
          }
          if (joined.includes("diff --") && joined.includes(".gitignore")) {
            return { status: 128, stdout: "", stderr: "fatal: timed out" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      },
      {
        // Force live git-diff path (no worktreeGitignoreDiff seam)
        porcelain: () => porcelain,
        headGitignore: () => "node_modules/\n",
        worktreeGitignore: () => "node_modules/\n",
        allUntracked: () => [RELEASE_SESSION_SCRATCH_GENERATION],
        isIgnoredBy: () => false,
      },
    );
    expect(decision.kind).toBe("dirty");
    if (decision.kind === "dirty") {
      expect(decision.reason).toContain("git diff -- .gitignore failed");
    }
  });

  it("refuses when a member addition would conceal non-allowlisted dirt", () => {
    const porcelain = [" M .gitignore", ""].join("\n");
    const decision = classifyReleaseInputCleanliness(
      "/repo",
      {},
      {
        porcelain: () => porcelain,
        stagedGitignoreDiff: () => "",
        worktreeGitignoreDiff: () => memberDiff,
        headGitignore: () => "node_modules/\n",
        worktreeGitignore: () => `node_modules/\n${memberLines.join("\n")}\n`,
        allUntracked: () => ["secrets.env"],
        isIgnoredBy: (body, path) => body.includes(".deft/*") && path.startsWith(".deft/"),
      },
    );
    expect(decision.kind).toBe("dirty");
    if (decision.kind === "dirty") expect(decision.reason).toMatch(/no-concealment/);
  });

  it("refuses staged .gitignore and non-member additions", () => {
    expect(
      classifyReleaseInputCleanliness(
        "/repo",
        {},
        {
          porcelain: () => "M  .gitignore\n",
          stagedGitignoreDiff: () => memberDiff,
          worktreeGitignoreDiff: () => "",
          headGitignore: () => "a\n",
          worktreeGitignore: () => "a\n",
          allUntracked: () => [],
          isIgnoredBy: () => true,
        },
      ).kind,
    ).toBe("dirty");
    expect(
      classifyReleaseInputCleanliness(
        "/repo",
        {},
        {
          porcelain: () => " M .gitignore\n",
          stagedGitignoreDiff: () => "",
          worktreeGitignoreDiff: () =>
            "diff --git a/.gitignore b/.gitignore\n+++ b/.gitignore\n+not-a-member\n",
          headGitignore: () => "a\n",
          worktreeGitignore: () => "a\nnot-a-member\n",
          allUntracked: () => [],
          isIgnoredBy: () => true,
        },
      ).kind,
    ).toBe("dirty");
  });

  it("real git ignore probe keeps ignored deps from poisoning session-scratch-only", () => {
    // Omit isIgnoredBy so defaultIsIgnoredBy runs real `git check-ignore`
    // against a throwaway repo (no unsupported -f). ls-files -o lists
    // node_modules/; a broken probe would mark it visible → dirty.
    const porcelain = [
      " M .gitignore",
      `?? ${RELEASE_SESSION_SCRATCH_GENERATION}`,
      `?? ${RELEASE_SESSION_SCRATCH_DIRECTIVE_DIR}`,
      "",
    ].join("\n");
    const headBody = "node_modules/\n";
    const wtBody = `node_modules/\n${memberLines.join("\n")}\n`;
    const decision = classifyReleaseInputCleanliness(
      "/repo",
      {},
      {
        porcelain: () => porcelain,
        stagedGitignoreDiff: () => "",
        worktreeGitignoreDiff: () => memberDiff,
        headGitignore: () => headBody,
        worktreeGitignore: () => wtBody,
        nestedGitignoreBodies: () => new Map(),
        allUntracked: () => [
          "node_modules/",
          "node_modules/pkg/index.js",
          RELEASE_SESSION_SCRATCH_GENERATION,
          `${RELEASE_SESSION_SCRATCH_DIRECTIVE_DIR}data-schema.json`,
        ],
      },
    );
    expect(decision.kind).toBe("session-scratch-only");
  });

  it("honors nested .gitignore so pack-stage does not poison session-scratch-only", () => {
    // Greptile P1: ls-files -o lists packages/runtime/.pack-stage/; without
    // materializing packages/runtime/.gitignore the probe treats it as visible.
    const porcelain = [
      " M .gitignore",
      `?? ${RELEASE_SESSION_SCRATCH_GENERATION}`,
      `?? ${RELEASE_SESSION_SCRATCH_DIRECTIVE_DIR}`,
      "",
    ].join("\n");
    const headBody = "node_modules/\n";
    const wtBody = `node_modules/\n${memberLines.join("\n")}\n`;
    const nested = new Map([["packages/runtime/.gitignore", ".pack-stage/\n"]]);
    const decision = classifyReleaseInputCleanliness(
      "/repo",
      {},
      {
        porcelain: () => porcelain,
        stagedGitignoreDiff: () => "",
        worktreeGitignoreDiff: () => memberDiff,
        headGitignore: () => headBody,
        worktreeGitignore: () => wtBody,
        nestedGitignoreBodies: () => nested,
        allUntracked: () => [
          "packages/runtime/.pack-stage/",
          "packages/runtime/.pack-stage/out.js",
          RELEASE_SESSION_SCRATCH_GENERATION,
          `${RELEASE_SESSION_SCRATCH_DIRECTIVE_DIR}data-schema.json`,
        ],
      },
    );
    expect(decision.kind).toBe("session-scratch-only");

    const withoutNested = classifyReleaseInputCleanliness(
      "/repo",
      {},
      {
        porcelain: () => porcelain,
        stagedGitignoreDiff: () => "",
        worktreeGitignoreDiff: () => memberDiff,
        headGitignore: () => headBody,
        worktreeGitignore: () => wtBody,
        nestedGitignoreBodies: () => new Map(),
        allUntracked: () => [
          "packages/runtime/.pack-stage/",
          RELEASE_SESSION_SCRATCH_GENERATION,
          `${RELEASE_SESSION_SCRATCH_DIRECTIVE_DIR}data-schema.json`,
        ],
      },
    );
    expect(withoutNested.kind).toBe("dirty");
    if (withoutNested.kind === "dirty") {
      expect(withoutNested.reason).toMatch(/no-concealment.*pack-stage/);
    }
  });

  it("fails closed when git ls-files -o fails or times out", () => {
    // Greptile P1: status !== 0 must not collapse to [] and admit scratch-only.
    const decision = classifyReleaseInputCleanliness(
      "/repo",
      {
        spawnText: (_cmd, args) => {
          if (args.includes("ls-files") && args.includes("-o")) {
            return {
              status: 128,
              stdout: "",
              stderr: "fatal: boom",
              signal: null,
              error: undefined,
            };
          }
          return { status: 0, stdout: "", stderr: "", signal: null, error: undefined };
        },
      },
      {
        porcelain: () => " M .gitignore\n",
        stagedGitignoreDiff: () => "",
        worktreeGitignoreDiff: () => memberDiff,
        headGitignore: () => "node_modules/\n",
        worktreeGitignore: () => `node_modules/\n${memberLines.join("\n")}\n`,
        nestedGitignoreBodies: () => new Map(),
        isIgnoredBy: () => true,
      },
    );
    expect(decision.kind).toBe("dirty");
    if (decision.kind === "dirty") {
      expect(decision.reason).toMatch(/git ls-files -o --directory failed/);
      expect(decision.reason).toMatch(/boom/);
    }
  });

  it("fails closed when the ignore probe errors", () => {
    const decision = classifyReleaseInputCleanliness(
      "/repo",
      {},
      {
        porcelain: () => " M .gitignore\n",
        stagedGitignoreDiff: () => "",
        worktreeGitignoreDiff: () => memberDiff,
        headGitignore: () => "node_modules/\n",
        worktreeGitignore: () => `node_modules/\n${memberLines.join("\n")}\n`,
        allUntracked: () => ["node_modules/"],
        isIgnoredBy: () => {
          throw new Error("git check-ignore probe failed (exit 128): boom");
        },
      },
    );
    expect(decision.kind).toBe("dirty");
    if (decision.kind === "dirty") {
      expect(decision.reason).toMatch(/no-concealment ignore probe failed/);
    }
  });
});

describe("runHostSmokeCheck (#6791)", () => {
  it("runs build, then the fixed host test files without coverage", () => {
    const calls: string[] = [];
    const [ok, reason] = runHostSmokeCheck("/repo", {
      pnpm: "pnpm",
      runner: (cmd, args) => {
        calls.push(`${cmd} ${args.join(" ")}`);
        return { status: 0 };
      },
    });
    expect(ok).toBe(true);
    expect(reason).toMatch(/no coverage/);
    expect(calls[0]).toBe("pnpm run build");
    expect(calls[1]).toBe(`pnpm exec vitest run ${RELEASE_HOST_SMOKE_TEST_FILES.join(" ")}`);
    expect(calls.join(" ")).not.toContain("--coverage");
  });

  it("fails on the first failing step, and without pnpm", () => {
    const [ok, reason] = runHostSmokeCheck("/repo", {
      pnpm: "pnpm",
      runner: () => ({ status: 1 }),
    });
    expect(ok).toBe(false);
    expect(reason).toMatch(/failed at pnpm run build \(exit 1\)/);
    const [errOk, errReason] = runHostSmokeCheck("/repo", {
      pnpm: "pnpm",
      runner: () => ({ status: null, error: new Error("spawn ETIMEDOUT") }),
    });
    expect(errOk).toBe(false);
    expect(errReason).toMatch(/ETIMEDOUT/);
    expect(runHostSmokeCheck("/repo", { pnpm: null })[0]).toBe(false);
  });
});

describe("smoke check deadline (#6791 Greptile P2)", () => {
  it("gives the second command only the time left of one shared deadline", () => {
    let clock = 1_000;
    const budgets: number[] = [];
    const [ok] = runHostSmokeCheck("/repo", {
      pnpm: "pnpm",
      nowMs: () => clock,
      runner: (_cmd, _args, _cwd, timeoutMs) => {
        budgets.push(timeoutMs);
        clock += timeoutMs - 5;
        return { status: 0 };
      },
    });
    expect(ok).toBe(true);
    expect(budgets).toEqual([RELEASE_CHECK_TIMEOUT_MS, 5]);
  });

  it("stops before the tests when the build used the whole deadline", () => {
    let clock = 0;
    let calls = 0;
    const [ok, reason] = runHostSmokeCheck("/repo", {
      pnpm: "pnpm",
      nowMs: () => clock,
      runner: (_cmd, _args, _cwd, timeoutMs) => {
        calls += 1;
        clock += timeoutMs;
        return { status: 0 };
      },
    });
    expect(ok).toBe(false);
    expect(reason).toMatch(/ran out of time before pnpm exec vitest run/);
    expect(calls).toBe(1);
  });
});

describe("smoke spawn has no shell injection (#6791 SLizard P1)", () => {
  const evilRoot = "C:evil&whoami|calc^x";

  it("keeps the project root out of the command line and never sets shell: true", () => {
    for (const platform of ["win32", "linux"] as const) {
      const plan = smokeSpawnPlan("pnpm", ["run", "build"], evilRoot, platform);
      expect(plan.shell).toBe(false);
      expect(plan.cwd).toBe(evilRoot);
      expect(plan.args.join(" ")).not.toContain("whoami");
    }
  });

  it("quotes a win32 shim path with metacharacters as one token", () => {
    const plan = smokeSpawnPlan("C:\tools&xpnpm.cmd", ["run", "build"], evilRoot, "win32");
    expect(plan.command).toBe("cmd.exe");
    expect(plan.windowsVerbatimArguments).toBe(true);
    expect(plan.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(plan.args[3]).toBe('""C:\tools&xpnpm.cmd" run build"');
    const posix = smokeSpawnPlan("/opt/a&b/pnpm", ["run", "build"], evilRoot, "linux");
    expect(posix).toMatchObject({ command: "/opt/a&b/pnpm", args: ["run", "build"] });
  });

  it("runs in a directory named with & | ^ as one cwd and runs no extra command", async () => {
    const parent = mkdtempSync(join(tmpdir(), "smoke-meta-"));
    const name = process.platform === "win32" ? "root&mkdir pwned^x" : "root&mkdir pwned|x^y";
    const root = join(parent, name);
    mkdirSync(root);
    try {
      const code = `process.exit(require('path').basename(process.cwd())===${JSON.stringify(name).replaceAll('"', "'")}?0:3)`;
      const plans: TimedChildPlan[] = [];
      const forwarded = runSmokeCommand(process.execPath, ["-e", code], root, 30_000, {
        timedRunner: (plan) => {
          plans.push(plan);
          return { ...OK_RESULT };
        },
        write: () => undefined,
      });
      expect(forwarded.status).toBe(0);
      const built = smokeSpawnPlan(process.execPath, ["-e", code], root);
      expect(plans[0]).toMatchObject({ command: built.command, args: built.args, cwd: root });
      const plan = plans[0] as TimedChildPlan;
      const result = await superviseTimedChild(plan);
      expect(result.spawnError).toBeUndefined();
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(root, "pwned"))).toBe(false);
      expect(existsSync(join(parent, "pwned"))).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 15_000);
});

const OK_RESULT: SupervisedGateResult = {
  exitCode: 0,
  timedOut: false,
  signal: null,
  stdout: "",
  stderr: "",
  teePath: "",
  teeRel: "",
};

describe("smoke command under the timed-child supervisor (#6904)", () => {
  it("passes the smoke plan, sanitized env and time left, and prints a start line and output", () => {
    const plans: TimedChildPlan[] = [];
    const written: string[] = [];
    const result = runSmokeCommand("pnpm", ["run", "build"], "/repo", 1_234, {
      platform: "linux",
      timedRunner: (plan) => {
        plans.push(plan);
        return { ...OK_RESULT, stdout: "built\n", stderr: "warn\n" };
      },
      write: (stream, text) => written.push(`${stream}:${text}`),
    });
    expect(result).toEqual({ status: 0 });
    expect(plans).toEqual([
      {
        command: "pnpm",
        args: ["run", "build"],
        cwd: "/repo",
        env: sanitizeTsLaneEnv(process.env),
        timeoutMs: 1_234,
        platform: "linux",
        windowsVerbatimArguments: false,
      },
    ]);
    expect(written).toEqual([
      "stdout:host smoke check: pnpm run build (1234 ms left)\n",
      "stdout:built\n",
      "stderr:warn\n",
    ]);
  });

  it("forwards the win32 shim plan", () => {
    const plans: TimedChildPlan[] = [];
    runSmokeCommand("C:\\pnpm.cmd", ["run", "build"], "C:\\repo", 5_000, {
      platform: "win32",
      timedRunner: (plan) => {
        plans.push(plan);
        return { ...OK_RESULT };
      },
      write: () => undefined,
    });
    const built = smokeSpawnPlan("C:\\pnpm.cmd", ["run", "build"], "C:\\repo", "win32");
    expect(plans[0]).toMatchObject({
      command: built.command,
      args: built.args,
      windowsVerbatimArguments: true,
      platform: "win32",
    });
  });

  it("maps each cleanup outcome and a spawn error to a failure", () => {
    const timedOut = { ...OK_RESULT, exitCode: 124, timedOut: true };
    const run = (result: SupervisedGateResult) =>
      runSmokeCommand("pnpm", ["run", "build"], "/repo", 1_000, {
        timedRunner: () => result,
        write: () => undefined,
      });
    const stopped = run({ ...timedOut, treeCleanup: "stopped" });
    expect(stopped.status).toBeNull();
    expect(stopped.error?.message).toMatch(/passed its deadline; its process tree was stopped/);
    const survivors = run({ ...timedOut, treeCleanup: "survivors", survivorPids: [41, 42] });
    expect(survivors.error?.message).toMatch(/still running after the kill: PID 41, 42/);
    expect(survivors.error?.message).not.toMatch(/tree was stopped/);
    const unverified = run({ ...timedOut, treeCleanup: "unverified" });
    expect(unverified.error?.message).toMatch(/cleanup could not be checked/);
    expect(unverified.error?.message).not.toMatch(/check PID/);
    const withPid = run({
      ...timedOut,
      treeCleanup: "unverified",
      lastReportedPid: 77,
      spawnError: "worker stalled",
    });
    expect(withPid.error?.message).toMatch(
      /check PID 77, which may already have exited and been reused/,
    );
    const workerFailed = run({
      ...OK_RESULT,
      exitCode: 1,
      spawnError: "worker exited",
      treeCleanup: "unverified",
      lastReportedPid: 78,
    });
    expect(workerFailed.error?.message).toMatch(/failed to run \(worker exited\).*check PID 78/);
    const spawnError = run({ ...OK_RESULT, exitCode: 1, spawnError: "spawn pnpm ENOENT" });
    expect(spawnError).toEqual({ status: null, error: new Error("spawn pnpm ENOENT") });
    expect(run({ ...OK_RESULT, exitCode: 3 })).toEqual({ status: 3 });
    expect(describeSmokeFailure("x", OK_RESULT)).toBeNull();
  });

  // One line: on win32 the smoke plan runs node through `cmd.exe /d /s /c`.
  const hangScript = (pidFile: string) =>
    [
      "const { spawn } = require('child_process');",
      "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });",
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, process.pid + ' ' + g.pid);`,
      "setTimeout(() => {}, 60000);",
    ].join(" ");

  async function runHungSmoke(
    scanFails: boolean,
  ): Promise<{ text: string; recorded: number[]; leftRunning: number[] }> {
    const dir = mkdtempSync(join(tmpdir(), "smoke-tree-"));
    const pidFile = join(dir, "pids.txt");
    const readPids = (): [number, number] | null => {
      if (!existsSync(pidFile)) return null;
      const [node, grand] = readFileSync(pidFile, "utf8").trim().split(" ").map(Number);
      return node !== undefined && grand !== undefined ? [node, grand] : null;
    };
    const plans: TimedChildPlan[] = [];
    runSmokeCommand(process.execPath, ["-e", hangScript(pidFile)], dir, 2_500, {
      timedRunner: (plan) => {
        plans.push(plan);
        return { ...OK_RESULT };
      },
      write: () => undefined,
    });
    // win32 has no `wmic` on current hosts, so there the scan is injected and
    // reads the recorded tree (cmd.exe -> node -> node); POSIX uses `pgrep`.
    let root: number | undefined;
    const recordedTree = (pid: number): number[] | null => {
      const pids = readPids();
      if (pids === null) return null;
      root ??= pid;
      if (pid === root && pid !== pids[0]) return [pids[0]];
      return pid === pids[0] ? [pids[1]] : [];
    };
    const listDirect = scanFails
      ? () => null
      : process.platform === "win32"
        ? recordedTree
        : undefined;
    try {
      const result = await superviseTimedChild({
        ...(plans[0] as TimedChildPlan),
        ...(listDirect !== undefined ? { listDirect } : {}),
      });
      const recorded = readPids() ?? [];
      // Sample liveness before the fallback cleanup below, so a leaked
      // descendant fails the test instead of being killed by the test.
      const leftRunning = recorded.filter((pid) => isPidRunning(pid));
      return { text: describeSmokeFailure("smoke", result) ?? "", recorded, leftRunning };
    } finally {
      for (const pid of readPids() ?? []) {
        if (isPidRunning(pid)) process.kill(pid, "SIGKILL");
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("stops a child that outlives the deadline and reports the tree stopped", async () => {
    const { text, recorded, leftRunning } = await runHungSmoke(false);
    expect(recorded).toHaveLength(2);
    expect(leftRunning).toEqual([]);
    expect(text).toMatch(/its process tree was stopped/);
  }, 20_000);

  it("still stops the child but reports unverified when the scan fails", async () => {
    const { text, recorded, leftRunning } = await runHungSmoke(true);
    expect(recorded).toHaveLength(2);
    expect(leftRunning).toEqual([]);
    expect(text).toMatch(/cleanup could not be checked/);
    expect(text).not.toMatch(/tree was stopped/);
  }, 20_000);
});
