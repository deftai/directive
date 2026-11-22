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
import type { CheckRunRecord } from "../pr-merge-readiness/gh.js";
import { MERGE_GATE_TASK_CHECK_NAME } from "../pr-wait-mergeable/constants.js";
import { sanitizeTsLaneEnv } from "../ts-check-lane/run-lane.js";
import {
  checkRunUrl,
  decideCiReuseFromRuns,
  describeSmokeFailure,
  evaluateCiReuse,
  formatCiReuseChange,
  formatCiReuseDecision,
  RELEASE_CI_REUSE_REQUIRED_CHECKS,
  RELEASE_HOST_SMOKE_TEST_FILES,
  runHostSmokeCheck,
  runSmokeCommand,
  selectLatestCheckRun,
  smokeSpawnPlan,
  TYPESCRIPT_BUILD_LINT_CHECK_NAME,
} from "./ci-reuse.js";
import { RELEASE_CHECK_TIMEOUT_MS } from "./constants.js";
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

  async function runHungSmoke(scanFails: boolean): Promise<{ text: string; recorded: number[] }> {
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
      const pids = readPids();
      expect(pids).not.toBeNull();
      return { text: describeSmokeFailure("smoke", result) ?? "", recorded: pids ?? [] };
    } finally {
      for (const pid of readPids() ?? []) {
        if (isPidRunning(pid)) process.kill(pid, "SIGKILL");
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("stops a child that outlives the deadline and reports the tree stopped", async () => {
    const { text, recorded } = await runHungSmoke(false);
    expect(recorded).toHaveLength(2);
    for (const pid of recorded) expect(isPidRunning(pid)).toBe(false);
    expect(text).toMatch(/its process tree was stopped/);
  }, 20_000);

  it("still stops the child but reports unverified when the scan fails", async () => {
    const { text, recorded } = await runHungSmoke(true);
    expect(recorded).toHaveLength(2);
    for (const pid of recorded) expect(isPidRunning(pid)).toBe(false);
    expect(text).toMatch(/cleanup could not be checked/);
    expect(text).not.toMatch(/tree was stopped/);
  }, 20_000);
});
