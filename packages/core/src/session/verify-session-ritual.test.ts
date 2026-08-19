import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { GitRunResult } from "./git.js";
import {
  defaultGitRunner,
  emitVerifyJson,
  formatCacheFreshDeferSoftPath,
  formatRitualRecoveryInstruction,
  GATED_ENTRYPOINT_COMMANDS,
  type GitRunner,
  inspectSessionRitual,
  newRitualStatePayload,
  readRitualState,
  ritualStep,
  type VerifyResult,
  verifySessionRitual,
  writeRitualState,
} from "./index.js";
import { defaultBranchSync, parseDeferrals, runSessionStart } from "./session-start.js";

function initRepo(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "session-verify-"));
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

function capturedGitRun(projectRoot: string, args: readonly string[]): GitRunResult {
  const result = spawnSync("git", [...args], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@t.local",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@t.local",
    },
  });
  return {
    code: result.status ?? 2,
    stdout: (result.stdout ?? "").trimEnd(),
    stderr: (result.stderr ?? "").trimEnd(),
  };
}

function fakeGit(head: string, worktree: string): GitRunner {
  return (projectRoot, args) => {
    if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") {
      const run = capturedGitRun(projectRoot, args);
      return { ...run, code: 0, stdout: head };
    }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      const run = capturedGitRun(projectRoot, args);
      return { ...run, code: 0, stdout: worktree };
    }
    return defaultGitRunner(projectRoot, args);
  };
}

function freshPayload(root: string, head: string, now: Date): Record<string, unknown> {
  return newRitualStatePayload({
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
      agent_hooks: ritualStep({ ok: true, ts: now }),
      doctor: ritualStep({ ok: true, ts: now }),
      cache_fresh: ritualStep({ ok: true, ts: now }),
    },
  });
}

function runGitCapture(root: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@t.local",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@t.local",
    },
  });
  if (result.status !== 0) {
    throw new Error((result.stderr ?? result.stdout ?? "git failed").trim());
  }
  // Capture stderr on the success path so parity diffs can observe it.
  void (result.stderr ?? "");
  return (result.stdout ?? "").trim();
}

function commitFile(root: string, name: string, message: string): string {
  writeFileSync(join(root, name), `${message}\n`, "utf8");
  runGitCapture(root, ["add", name]);
  runGitCapture(root, ["commit", "-q", "-m", message]);
  return runGitCapture(root, ["rev-parse", "HEAD"]);
}

describe("forward HEAD rebind (#2782)", () => {
  it("verify rebinds ritual git_head after a forward commit", () => {
    const { root, head: initialHead } = initRepo();
    const now = new Date("2026-07-23T12:00:00Z");
    writeRitualState(root, freshPayload(root, initialHead, now));
    const advancedHead = commitFile(root, "next.txt", "forward");

    const result = verifySessionRitual(root, {
      tier: "gated",
      now,
      bypass: false,
      posture: "mutation",
      runner: () => ({ code: 0, stdout: "hooks ready", stderr: "" }),
    });
    expect(result.code).toBe(0);
    const [state] = readRitualState(root);
    expect(state?.gitHead).toBe(advancedHead);
    rmSync(root, { recursive: true, force: true });
  });

  it("gated step refresh preserves precheck forward HEAD rebind", () => {
    const { root, head: initialHead } = initRepo();
    const now = new Date("2026-07-23T12:00:00Z");
    const payload = freshPayload(root, initialHead, now);
    const gated = { ...(payload.gated_steps as Record<string, Record<string, unknown>>) };
    gated.doctor = ritualStep({ ok: false, ts: now, message: "stale" });
    payload.gated_steps = gated;
    writeRitualState(root, payload);
    const advancedHead = commitFile(root, "next.txt", "forward");

    const result = verifySessionRitual(root, {
      tier: "gated",
      now,
      bypass: false,
      posture: "mutation",
      runner: () => ({ code: 0, stdout: "ok", stderr: "" }),
    });
    expect(result.code).toBe(0);
    const [state] = readRitualState(root);
    expect(state?.gitHead).toBe(advancedHead);
    rmSync(root, { recursive: true, force: true });
  });

  it("inspect accepts forward HEAD without rewriting ritual state", () => {
    const { root, head: initialHead } = initRepo();
    const now = new Date("2026-07-23T12:00:00Z");
    writeRitualState(root, freshPayload(root, initialHead, now));
    commitFile(root, "next.txt", "forward");

    const before = readRitualState(root)[0]?.gitHead;
    const result = inspectSessionRitual(root, {
      tier: "gated",
      posture: "mutation",
      now,
    });
    expect(result.code).toBe(0);
    expect(readRitualState(root)[0]?.gitHead).toBe(before);
    rmSync(root, { recursive: true, force: true });
  });

  it("denies reset off the pinned commit", () => {
    const { root, head: initialHead } = initRepo();
    const now = new Date("2026-07-23T12:00:00Z");
    const advancedHead = commitFile(root, "next.txt", "forward");
    writeRitualState(root, freshPayload(root, advancedHead, now));
    runGitCapture(root, ["reset", "--hard", initialHead]);

    const result = inspectSessionRitual(root, {
      tier: "gated",
      posture: "mutation",
      now,
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("discontinuously");
    rmSync(root, { recursive: true, force: true });
  });

  it("fails closed when git history cannot be verified", () => {
    const { root, head } = initRepo();
    const now = new Date("2026-07-23T12:00:00Z");
    writeRitualState(root, freshPayload(root, head, now));
    const brokenGit: GitRunner = (_r, args) => {
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        return { code: 128, stdout: "", stderr: "bad object" };
      }
      return fakeGit(head, resolve(root))(_r, args);
    };
    const advancedHead = commitFile(root, "next.txt", "forward");
    const result = inspectSessionRitual(root, {
      tier: "gated",
      posture: "mutation",
      now,
      runGit: (_r, args) => {
        if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") {
          return { code: 0, stdout: advancedHead, stderr: "" };
        }
        return brokenGit(_r, args);
      },
    });
    expect(result.code).toBe(2);
    expect(result.message).toContain("could not verify git history");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("verify session ritual", () => {
  it("defines agent-hook readiness as the first dedicated gated command", () => {
    expect(GATED_ENTRYPOINT_COMMANDS.agent_hooks).toEqual([
      "verify:hooks-installed",
      "--scope=agent",
      "--live",
    ]);
  });

  it("runs and records a missing agent-hook readiness prerequisite", () => {
    const { root, head } = initRepo();
    const now = new Date("2026-06-09T01:00:00Z");
    const payload = freshPayload(root, head, now);
    const gated = { ...(payload.gated_steps as Record<string, Record<string, unknown>>) };
    delete gated.agent_hooks;
    payload.gated_steps = gated;
    writeRitualState(root, payload);
    const commands: string[][] = [];

    const result = verifySessionRitual(root, {
      tier: "gated",
      posture: "mutation",
      now,
      envSkip: "",
      runGit: fakeGit(head, resolve(root)),
      runner: (command) => {
        commands.push([...command]);
        return { code: 0, stdout: "hooks ready", stderr: "" };
      },
    });

    expect(result.code).toBe(0);
    expect(commands).toEqual([["verify:hooks-installed", "--scope=agent", "--live"]]);
    expect(readRitualState(root)[0]?.gatedSteps.agent_hooks).toMatchObject({
      ok: true,
      exit_code: 0,
      message: "hooks ready",
    });
    rmSync(root, { recursive: true, force: true });
  });

  it("can force a fresh agent-hook readiness probe for session:ready", () => {
    const { root, head } = initRepo();
    const now = new Date("2026-06-09T01:00:00Z");
    writeRitualState(root, freshPayload(root, head, now));
    const commands: string[][] = [];

    const result = verifySessionRitual(root, {
      tier: "gated",
      posture: "mutation",
      now,
      envSkip: "",
      runGit: fakeGit(head, resolve(root)),
      forceGatedSteps: ["agent_hooks"],
      runner: (command) => {
        commands.push([...command]);
        return { code: 1, stdout: "", stderr: "hooks non-functional" };
      },
    });

    expect(result.code).toBe(1);
    expect(result.message).toContain("agent_hooks");
    expect(commands).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });

  it("missing state fails closed at gated mutation boundary", () => {
    const { root, head } = initRepo();
    const result = verifySessionRitual(root, {
      tier: "gated",
      runGit: fakeGit(head, resolve(root)),
      bypass: false,
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("deft session:start");
    rmSync(root, { recursive: true, force: true });
  });

  it("missing state passes in read-only quick posture (#2180)", () => {
    const { root, head } = initRepo();
    const result = verifySessionRitual(root, {
      tier: "quick",
      posture: "read-only",
      runGit: fakeGit(head, resolve(root)),
      bypass: false,
    });
    expect(result.code).toBe(0);
    expect(result.message).toContain("read-only posture");
    rmSync(root, { recursive: true, force: true });
  });

  it("accepts fresh quick state", () => {
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
      }),
    );
    const result = verifySessionRitual(root, {
      now,
      runGit: fakeGit(head, resolve(root)),
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(emitVerifyJson(result)).ready).toBe(true);
    expect(JSON.parse(emitVerifyJson(result)).recovery_tier).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it("emitVerifyJson carries recovery_tier (#3506)", () => {
    const failed: VerifyResult = {
      code: 1,
      message: "session ritual gated step 'cache_fresh' failed",
      tier: "gated",
      statePath: "/tmp/ritual-state.json",
      bypassed: false,
      wouldFailCode: null,
      posture: "mutation",
      ritualStateRequired: true,
      recoveryTier: "cold",
    };
    const payload = JSON.parse(emitVerifyJson(failed)) as Record<string, unknown>;
    expect(payload.recovery_tier).toBe("cold");
    expect(payload.ready).toBe(false);
    expect(payload.exit_code).toBe(1);
    expect(payload.tier).toBe("gated");
    expect(payload.message).toBe(failed.message);
    expect(payload.state_path).toBe(failed.statePath);
    expect(payload.bypassed).toBe(false);
    expect(payload.would_fail_code).toBeNull();
    expect(payload.posture).toBe("mutation");
    expect(payload.ritual_state_required).toBe(true);
    expect(formatRitualRecoveryInstruction("cold")).toContain("session:ready");
    expect(formatCacheFreshDeferSoftPath()).toContain("--defer cache_fresh=<reason>");
    expect(formatCacheFreshDeferSoftPath()).toContain("audited");
  });

  it("bypass returns success with would_fail_code", () => {
    const { root, head } = initRepo();
    const result = verifySessionRitual(root, {
      bypass: true,
      posture: "mutation",
      runGit: fakeGit(head, resolve(root)),
    });
    expect(result.code).toBe(0);
    expect(result.wouldFailCode).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("session start helpers", () => {
  it("parseDeferrals validates input", () => {
    const bad = parseDeferrals(["nope"]);
    expect(bad.errors.length).toBeGreaterThan(0);
    const ok = parseDeferrals(["alignment=later"]);
    expect(ok.deferrals.alignment).toBe("later");
    expect(parseDeferrals(["agent_hooks=later"]).errors.join(" ")).toContain("not deferrable");
  });

  it("runSessionStart records state with fakes", () => {
    const { root, head } = initRepo();
    const now = new Date("2026-06-09T01:00:00Z");
    const result = runSessionStart(root, {
      now,
      newSessionId: () => "fixed-id",
      runGit: fakeGit(head, resolve(root)),
      verifyTools: (output) => {
        output("[deft tools] Required tools are available.");
        return { exitCode: 0 };
      },
      runTriageWelcome: (_r, opts) => {
        opts.output("[triage] ok");
        return { exitCode: 0 };
      },
      writeHistory: false,
    });
    expect(result.code).toBe(0);
    expect(result.payload.ready).toBe(true);
    expect(result.payload.gated_steps).not.toHaveProperty("agent_hooks");
    rmSync(root, { recursive: true, force: true });
  });

  it("defaultBranchSync handles missing upstream", () => {
    const { root } = initRepo();
    const sync = defaultBranchSync(root, () => ({
      code: 1,
      stdout: "",
      stderr: "",
    }));
    expect(sync.warning).toContain("default branch");
    rmSync(root, { recursive: true, force: true });
  });
});
