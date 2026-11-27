import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentHookInspection } from "../init-deposit/agent-hooks.js";
import type {
  AgentHookReadinessHostResult,
  AgentHookReadinessOptions,
  AgentHookReadinessResult,
} from "../verify-env/agent-hook-readiness.js";
import {
  LIVE_PROBE_UNKNOWN_HOST_DEADLINE_MS,
  LIVE_PROBE_WRITE_BUDGET_MS,
} from "../verify-env/agent-hooks-live-probe.js";
import { nextAgentHookHostEntry } from "./agent-hook-allowance.js";
import type { GitRunner } from "./git.js";
import { defaultGitRunner } from "./git.js";
import {
  newRitualStatePayload,
  readRitualState,
  ritualStep,
  verifySessionRitual,
  writeRitualState,
} from "./index.js";
import {
  callMain,
  type DefaultRitualRunnerSeams,
  defaultRitualRunner,
  type RitualRunContext,
  runCacheFreshMain,
} from "./ritual-entrypoint.js";

function initRepo(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "session-default-runner-"));
  writeFileSync(join(root, "README.md"), "x\n", "utf8");
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "T",
        status: "running",
        items: [],
        policy: { sessionRitualStalenessHours: 4 },
      },
    }),
    "utf8",
  );
  execFileSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["config", "user.name", "T"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["add", "-A"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["commit", "-q", "-m", "init"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@t.local",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@t.local",
    },
  });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  return { root, head };
}

function repoGitRunner(root: string): GitRunner {
  return (projectRoot, args) => defaultGitRunner(projectRoot ?? root, args);
}

describe("defaultRitualRunner", () => {
  it("runs functional agent-hook readiness in process", () => {
    const result = defaultRitualRunner(
      ["verify:hooks-installed", "--scope=agent", "--live"],
      "/project",
      {
        evaluateAgentHookReadiness: () => ({
          code: 0,
          message: "hooks ready",
          stream: "stdout",
          skipped: false,
          liveStatus: "functional",
          hosts: [],
          registrations: [],
          liveProbe: null,
        }),
      },
    );

    expect(result).toEqual({ code: 0, stdout: "hooks ready\n", stderr: "" });
  });

  it("runs cache-fresh with allow-missing-bootstrap on a fresh repo", () => {
    const { root } = initRepo();
    const result = defaultRitualRunner(["verify:cache-fresh"], root);
    expect(result.code).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/cache-fresh/i);
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects unknown gated commands", () => {
    const result = defaultRitualRunner(["future:gated"], "/tmp");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown session ritual command: future:gated");
  });

  it("captures stdout and stderr from entrypoints", () => {
    const result = callMain(
      (argv) => {
        process.stdout.write(`echo ${argv.join(" ")}\n`);
        process.stderr.write("warn\n");
        return 0;
      },
      ["--flag"],
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("echo --flag");
    expect(result.stderr).toContain("warn");
  });

  it("maps thrown errors to exit code 2", () => {
    const result = callMain(() => {
      throw new Error("boom");
    }, []);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Error: boom");
  });
});

describe("verifySessionRitual gated tier via defaultRitualRunner", () => {
  it("records cache_fresh via defaultRitualRunner after a ready hook probe", () => {
    const { root, head } = initRepo();
    const now = new Date("2026-06-09T01:00:00Z");
    writeRitualState(
      root,
      newRitualStatePayload({
        sessionId: "s",
        gitHead: head,
        worktreePath: resolve(root),
        startedAt: now,
        quickSteps: {
          alignment: ritualStep({ ok: true, ts: now }),
          branch_policy: ritualStep({ ok: true, ts: now }),
          triage_welcome: ritualStep({ ok: true, ts: now }),
          verify_tools: ritualStep({ ok: true, ts: now }),
        },
        gatedSteps: {
          agent_hooks: ritualStep({ ok: true, ts: now, message: "seeded for test" }),
          doctor: ritualStep({ ok: true, ts: now, message: "seeded for test" }),
        },
      }),
    );

    const result = verifySessionRitual(root, {
      tier: "gated",
      now,
      bypass: false,
      envSkip: "",
      runGit: repoGitRunner(root),
      runner: (command, projectRoot) =>
        command[0] === "verify:hooks-installed"
          ? { code: 0, stdout: "hooks ready", stderr: "" }
          : defaultRitualRunner(command, projectRoot),
    });
    expect(result.code).toBe(0);
    const [state] = readRitualState(root);
    expect(state).not.toBeNull();
    expect(state?.gatedSteps.doctor?.ok).toBe(true);
    expect(state?.gatedSteps.cache_fresh?.ok).toBe(true);
    expect(state?.gatedSteps.cache_fresh?.command).toEqual([
      "verify:cache-fresh",
      "--skip-drift-probe",
    ]);
    expect(state?.raw.drift_probe).toBe("skipped-no-work-selection");
    expect(state?.gatedSteps.cache_fresh?.deferred_reason).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  it("defaultRitualRunner invokes doctor on a real repo", () => {
    const { root, head } = initRepo();
    const headResult = defaultGitRunner(root, ["rev-parse", "--verify", "HEAD"]);
    expect(headResult.code).toBe(0);
    expect(headResult.stdout).toBe(head);
    const doctor = defaultRitualRunner(["doctor"], root);
    expect(doctor.code).toBeGreaterThanOrEqual(0);
    expect(`${doctor.stdout}${doctor.stderr}`).toMatch(/doctor|Deft|agents-md/i);
    rmSync(root, { recursive: true, force: true });
  });

  it("runCacheFreshMain honours allow-missing-bootstrap", () => {
    const { root } = initRepo();
    const code = runCacheFreshMain(["--allow-missing-bootstrap", "--project-root", root]);
    expect(code).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("runCacheFreshMain honours --skip-drift-probe (#3507)", () => {
    const { root } = initRepo();
    const code = runCacheFreshMain([
      "--allow-missing-bootstrap",
      "--skip-drift-probe",
      "--project-root",
      root,
    ]);
    expect(code).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("runCacheFreshMain lets --work-selection override --skip-drift-probe (#3507)", () => {
    const { root } = initRepo();
    const code = runCacheFreshMain([
      "--allow-missing-bootstrap",
      "--skip-drift-probe",
      "--work-selection",
      "--project-root",
      root,
    ]);
    expect(code).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("agent_hooks step scope and allowance (#7416)", () => {
  const COMMAND = ["verify:hooks-installed", "--scope=agent", "--live"];
  const NOW = new Date("2026-11-27T10:00:00Z");
  const IDENTITY = { path: "/bin/deft-hook", size: 10, mtimeMs: 5 };
  const HOSTS = ["claude", "grok", "cursor", "codex", "agy"] as const;

  const registrationsFor = (): AgentHookInspection[] =>
    HOSTS.map((host) => ({
      host,
      path: ".claude/settings.json" as AgentHookInspection["path"],
      status: "healthy",
      detail: "ok",
      compactSupport: "deposited",
      sessionEndSupport: "deposited",
      sessionEndRegistered: null,
    })) as unknown as AgentHookInspection[];

  function readiness(
    statuses: Partial<
      Record<(typeof HOSTS)[number], AgentHookReadinessHostResult["functionality"]>
    >,
  ): AgentHookReadinessResult {
    const probed = HOSTS.filter((host) => statuses[host] !== undefined);
    const failing = probed.filter((host) => statuses[host] !== "functional");
    const timeoutOnly =
      failing.length > 0 && failing.every((host) => statuses[host] === "timed-out");
    return {
      code: failing.length === 0 ? 0 : 1,
      message: failing.length === 0 ? "hooks ready" : "❌ hooks failed",
      stream: failing.length === 0 ? "stdout" : "stderr",
      skipped: false,
      liveStatus:
        failing.length === 0 ? "functional" : timeoutOnly ? "timed-out" : "non-functional",
      hosts: HOSTS.map((host) => ({
        host,
        registration: "registered",
        functionality: statuses[host] ?? "not-run",
        trust: "not-applicable",
        interception: "not-directly-verified",
      })),
      registrations: registrationsFor(),
      liveProbe: {
        code: failing.length === 0 ? 0 : 1,
        message: "probe",
        cases: failing.map((host) => ({
          host,
          event: "tool.before",
          fixture: "allow",
          issue: statuses[host] === "timed-out" ? "timed-out" : "empty-stdout",
          detail: "x",
        })),
        hosts: probed.map((host) => ({ host, status: statuses[host] as "functional" })),
        durationMs: 1,
        commandIdentity: IDENTITY,
      },
    };
  }

  function run(
    ready: AgentHookReadinessResult,
    context: RitualRunContext,
    extra: Partial<DefaultRitualRunnerSeams> = {},
  ) {
    const calls: { options: AgentHookReadinessOptions | undefined }[] = [];
    const result = defaultRitualRunner(
      COMMAND,
      "/project",
      {
        evaluateAgentHookReadiness: (_root, options) => {
          calls.push({ options });
          return ready;
        },
        resolveGraceMs: () => 8 * 60 * 60 * 1000,
        ...extra,
      },
      context,
    );
    return { result, calls };
  }

  it("a known host probes only itself under the write budget", () => {
    const { result, calls } = run(readiness({ claude: "functional" }), {
      surface: "write",
      host: "claude",
      now: NOW,
    });
    expect(calls[0]?.options).toMatchObject({
      hosts: ["claude"],
      probeDeadlineMs: LIVE_PROBE_WRITE_BUDGET_MS,
    });
    expect(result.code).toBe(0);
    expect(Object.keys(result.agentHookHosts ?? {})).toEqual(["claude"]);
    expect(result.agentHookHosts?.claude).toMatchObject({
      status: "functional",
      allowance_open: true,
    });
  });

  it("an unknown host probes every host under the fallback deadline with no allowance", () => {
    let takes = 0;
    const { result, calls } = run(
      readiness({ claude: "functional", grok: "timed-out" }),
      { surface: "write", host: "not-a-host", now: NOW },
      {
        takeAllowance: () => {
          takes += 1;
          return { admitted: true, entry: null, reason: "x", saveFailed: false };
        },
      },
    );
    expect(calls[0]?.options?.hosts).toBeUndefined();
    expect(calls[0]?.options?.probeDeadlineMs).toBe(LIVE_PROBE_UNKNOWN_HOST_DEADLINE_MS);
    expect(takes).toBe(0);
    expect(result.code).toBe(1);
    expect(result.agentHookHosts?.grok).toMatchObject({ status: "timed-out", ok: false });
  });

  it("admits one applying-host timeout with a warning when the allowance is taken", () => {
    const entry = nextAgentHookHostEntry(
      null,
      { status: "timed-out", ok: true, identity: null, registrationDigest: null },
      NOW,
    );
    const { result } = run(
      readiness({ grok: "timed-out" }),
      { surface: "write", host: "grok", now: NOW },
      { takeAllowance: () => ({ admitted: true, entry, reason: "ok", saveFailed: false }) },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("admitted once");
    expect(result.agentHookHosts?.grok).toEqual(entry);
  });

  it("blocks the applying-host timeout when the allowance is refused or cannot be saved", () => {
    const refused = run(
      readiness({ grok: "timed-out" }),
      { surface: "write", host: "grok", now: NOW },
      {
        takeAllowance: () => ({
          admitted: false,
          entry: null,
          reason: "closed",
          saveFailed: false,
        }),
      },
    );
    expect(refused.result.code).toBe(1);
    expect(refused.result.stderr).toContain("no timeout allowance: closed");
    const unsaved = run(
      readiness({ grok: "timed-out" }),
      { surface: "write", host: "grok", now: NOW },
      { takeAllowance: () => ({ admitted: false, entry: null, reason: "lock", saveFailed: true }) },
    );
    expect(unsaved.result.code).toBe(1);
    expect(unsaved.result.stderr).toContain("the write is refused: lock");
  });

  it.each([
    "non-functional",
    "unavailable",
  ] as const)("blocks a %s applying host without consulting the allowance", (status) => {
    let takes = 0;
    const { result } = run(
      readiness({ claude: status }),
      { surface: "write", host: "claude", now: NOW },
      {
        takeAllowance: () => {
          takes += 1;
          return { admitted: true, entry: null, reason: "x", saveFailed: false };
        },
      },
    );
    expect(result.code).toBe(1);
    expect(takes).toBe(0);
    expect(result.agentHookHosts?.claude).toMatchObject({ status, allowance_open: false });
  });

  it("session:ready style runs pass with a warning on timeout-only and fail otherwise", () => {
    const timeoutOnly = run(readiness({ claude: "functional", grok: "timed-out" }), {
      surface: "ritual",
      now: NOW,
    });
    expect(timeoutOnly.calls[0]?.options).toEqual({});
    expect(timeoutOnly.result.code).toBe(0);
    expect(timeoutOnly.result.stdout).toContain("⚠");
    expect(timeoutOnly.result.agentHookHosts?.grok).toMatchObject({
      status: "timed-out",
      ok: true,
      allowance_open: false,
    });
    expect(timeoutOnly.result.agentHookHosts?.claude).toMatchObject({ status: "functional" });
    const mixed = run(readiness({ grok: "timed-out", cursor: "non-functional" }), {
      surface: "ritual",
      now: NOW,
    });
    expect(mixed.result.code).toBe(1);
  });

  it("a structural failure is not a timeout pass on the ritual surface", () => {
    const result = defaultRitualRunner(
      COMMAND,
      "/project",
      {
        evaluateAgentHookReadiness: () => ({
          code: 1,
          message: "❌ structural drift",
          stream: "stderr",
          skipped: false,
          liveStatus: "not-run",
          hosts: [],
          registrations: registrationsFor().map((entry) =>
            entry.host === "grok"
              ? ({ ...entry, status: "drifted" } as AgentHookInspection)
              : entry,
          ),
          liveProbe: null,
        }),
      },
      { surface: "ritual", now: NOW },
    );
    expect(result.code).toBe(1);
  });
});
