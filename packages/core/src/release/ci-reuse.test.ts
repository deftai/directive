import { describe, expect, it } from "vitest";
import type { CheckRunRecord } from "../pr-merge-readiness/gh.js";
import { MERGE_GATE_TASK_CHECK_NAME } from "../pr-wait-mergeable/constants.js";
import {
  checkRunUrl,
  decideCiReuseFromRuns,
  evaluateCiReuse,
  formatCiReuseChange,
  formatCiReuseDecision,
  RELEASE_CI_REUSE_REQUIRED_CHECKS,
  RELEASE_HOST_SMOKE_TEST_FILES,
  runHostSmokeCheck,
  selectLatestCheckRun,
  TYPESCRIPT_BUILD_LINT_CHECK_NAME,
} from "./ci-reuse.js";
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

function ghReturning(runs: readonly CheckRunRecord[] | null) {
  const calls: string[] = [];
  const runGh = (cmd: readonly string[]) => {
    calls.push(cmd.join(" "));
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

  it("prints a changed decision only when it differs from readiness", () => {
    const reuse = decideCiReuseFromRuns(REPO, TIP, TREE, GREEN);
    const fullRun = { kind: "full" as const, reason: "latest attempt failed", tipSha: TIP };
    expect(formatCiReuseChange(null, fullRun)).toBeNull();
    expect(formatCiReuseChange("full", fullRun)).toBeNull();
    expect(formatCiReuseChange("reuse", fullRun)).toMatch(/was reuse, now the full local check/);
    expect(formatCiReuseChange("full", reuse)).toMatch(/now reuse/);
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
