import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decideHook } from "../hooks/dispatcher.js";
import type { EnvironmentContext } from "../platform/shell-context.js";
import type { GitRunResult } from "./git.js";
import {
  markRitualStaleAfterCompact,
  newRitualStatePayload,
  readRitualState,
  ritualStep,
  writeRitualState,
} from "./ritual-sentinel.js";
import {
  assessRearmEligibility,
  formatSessionStartRecoveryCommand,
  REARM_CEREMONY_TIER,
  REARM_INELIGIBLE_PREFIX,
  REARM_SKIPPED_FAT_PATH_MESSAGE,
  runSessionStart,
  type SessionStartStepTiming,
} from "./session-start.js";
import { inspectSessionRitual } from "./verify-session-ritual.js";

const temps: string[] = [];
const environment: EnvironmentContext = {
  hostPlatform: "darwin",
  shell: { name: "zsh", path: "/bin/zsh", kind: "default", source: "SHELL" },
};

afterEach(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  temps.length = 0;
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "session-rearm-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief"), { recursive: true });
  mkdirSync(join(root, ".deft"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: { policy: { sessionRitualStalenessHours: 4 } },
    }),
    "utf8",
  );
  return root;
}

function fakeGit(
  root: string,
  options: { head?: string; worktree?: string; ancestorOk?: boolean } = {},
): (r: string, args: readonly string[]) => GitRunResult {
  const head = options.head ?? "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  const worktree = options.worktree ?? root;
  const ancestorOk = options.ancestorOk ?? true;
  return (_r, args) => {
    if (args[0] === "rev-parse" && args.includes("HEAD")) {
      return { code: 0, stdout: head, stderr: "" };
    }
    if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
      return { code: 0, stdout: worktree, stderr: "" };
    }
    if (args[0] === "merge-base" && args.includes("--is-ancestor")) {
      return { code: ancestorOk ? 0 : 1, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "" };
  };
}

function seedRitual(
  root: string,
  input: {
    head: string;
    worktree?: string;
    startedAt: Date;
    triageOk?: boolean;
  },
): void {
  const ts = input.startedAt;
  writeRitualState(
    root,
    newRitualStatePayload({
      sessionId: "seed-session",
      gitHead: input.head,
      worktreePath: resolve(input.worktree ?? root),
      startedAt: ts,
      quickSteps: {
        alignment: ritualStep({ ok: true, ts }),
        branch_policy: ritualStep({ ok: true, ts }),
        // #3214: seed tools outcome so re-arm preserves without re-run.
        verify_tools: ritualStep({
          ok: true,
          ts,
          message: "verify:tools seed",
          exitCode: 0,
        }),
        triage_welcome: ritualStep({
          ok: input.triageOk !== false,
          ts,
          message: "triage welcome seed",
        }),
      },
      gatedSteps: {
        agent_hooks: ritualStep({ ok: true, ts }),
        doctor: ritualStep({ ok: true, ts }),
        cache_fresh: ritualStep({ ok: true, ts }),
      },
    }),
  );
}

describe("session re-arm vs cold ceremony tiers (#2992)", () => {
  it("formatSessionStartRecoveryCommand distinguishes rearm vs cold", () => {
    expect(formatSessionStartRecoveryCommand("rearm")).toContain("session:start --rearm");
    expect(formatSessionStartRecoveryCommand("cold")).toMatch(/session:start$/);
    expect(formatSessionStartRecoveryCommand("cold")).not.toContain("--rearm");
  });

  it("re-arm refreshes ritual without tools/triage/release/tickler", () => {
    const root = tempRoot();
    const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const started = new Date("2026-07-20T12:00:00Z");
    seedRitual(root, { head, startedAt: started });

    let toolsCalls = 0;
    let triageCalls = 0;
    let releaseCalls = 0;
    let ticklerCalls = 0;
    const rearmAt = new Date("2026-07-20T16:30:00Z");
    const result = runSessionStart(root, {
      ceremonyTier: REARM_CEREMONY_TIER,
      now: rearmAt,
      writeHistory: false,
      runGit: fakeGit(root, { head }),
      verifyTools: () => {
        toolsCalls += 1;
        return { exitCode: 0 };
      },
      runTriageWelcome: () => {
        triageCalls += 1;
        return { exitCode: 0 };
      },
      probeReleaseAvailability: () => {
        releaseCalls += 1;
        return { lines: ["should not run"] };
      },
      runStalenessTickler: () => {
        ticklerCalls += 1;
        return { lines: ["should not run"], prompted: false };
      },
      resolveUserMd: () => ({
        path: join(root, "USER.md"),
        rung: "workspace-local",
        found: true,
        diagnostic: "ok",
        searched: [],
      }),
      probeEnvironment: () => environment,
      newSessionId: () => "rearm-session",
    });

    expect(result.code).toBe(0);
    expect(toolsCalls).toBe(0);
    expect(triageCalls).toBe(0);
    expect(releaseCalls).toBe(0);
    expect(ticklerCalls).toBe(0);
    expect(result.lines).toContain(REARM_SKIPPED_FAT_PATH_MESSAGE);
    expect(result.payload.ceremony_tier).toBe("rearm");
    expect(result.payload.message).toBe("session ritual re-armed");
    expect(result.payload.optional_network).toBe(false);

    const steps = result.payload.steps as SessionStartStepTiming[];
    expect(steps.find((s) => s.name === "verify_tools")?.skipped).toBe(true);
    expect(steps.find((s) => s.name === "triage_welcome")?.skipped).toBe(true);
    expect(steps.find((s) => s.name === "release_probe")?.skipped).toBe(true);

    const [state] = readRitualState(root);
    expect(state?.sessionId).toBe("rearm-session");
    expect(state?.startedAt.toISOString()).toBe(rearmAt.toISOString());
    expect(state?.gitHead).toBe(head);
    expect(state?.raw.rearm_needed).toBeUndefined();
    expect(state?.raw.compact_resume_at).toBeUndefined();
    expect(state?.raw.ceremony_tier).toBe("rearm");
    expect(state?.quickSteps.triage_welcome.message).toBe("triage welcome seed");

    const inspect = inspectSessionRitual(root, {
      tier: "gated",
      posture: "mutation",
      now: rearmAt,
      runGit: fakeGit(root, { head }),
    });
    expect(inspect.code).toBe(0);
  });

  it("re-arm refuses when ritual state is missing (cold required)", () => {
    const root = tempRoot();
    const result = runSessionStart(root, {
      ceremonyTier: REARM_CEREMONY_TIER,
      writeHistory: false,
      runGit: fakeGit(root),
      probeEnvironment: () => environment,
    });
    expect(result.code).toBe(1);
    expect(result.payload.rearm_eligible).toBe(false);
    expect(String(result.payload.message)).toContain(REARM_INELIGIBLE_PREFIX);
    expect(String(result.payload.message)).toContain("session:start");
    expect(String(result.payload.message)).not.toContain("--rearm");
  });

  it("re-arm refuses on worktree change", () => {
    const root = tempRoot();
    const head = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    seedRitual(root, {
      head,
      startedAt: new Date("2026-07-20T12:00:00Z"),
      worktree: "/other/worktree",
    });
    const eligibility = assessRearmEligibility(root, {
      runGit: fakeGit(root, { head, worktree: root }),
    });
    expect(eligibility.eligible).toBe(false);
    if (!eligibility.eligible) {
      expect(eligibility.reason).toContain("different worktree");
    }
  });

  it("re-arm refuses on discontinuous HEAD", () => {
    const root = tempRoot();
    const prior = "cccccccccccccccccccccccccccccccccccccccc";
    const current = "dddddddddddddddddddddddddddddddddddddddd";
    seedRitual(root, { head: prior, startedAt: new Date("2026-07-20T12:00:00Z") });
    const eligibility = assessRearmEligibility(root, {
      runGit: fakeGit(root, { head: current, ancestorOk: false }),
    });
    expect(eligibility.eligible).toBe(false);
    if (!eligibility.eligible) {
      expect(eligibility.reason).toContain("discontinuously");
    }
  });

  it("re-arm refuses when a quick step previously failed", () => {
    const root = tempRoot();
    const head = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    seedRitual(root, {
      head,
      startedAt: new Date("2026-07-20T12:00:00Z"),
      triageOk: false,
    });
    const eligibility = assessRearmEligibility(root, {
      runGit: fakeGit(root, { head }),
    });
    expect(eligibility.eligible).toBe(false);
    if (!eligibility.eligible) {
      expect(eligibility.reason).toContain("triage_welcome");
    }
  });

  it("age-stale inspect prefers re-arm recovery tier", () => {
    const root = tempRoot();
    const head = "ffffffffffffffffffffffffffffffffffffffff";
    seedRitual(root, { head, startedAt: new Date("2026-07-20T08:00:00Z") });
    const staleAt = new Date("2026-07-20T13:00:00Z"); // >4h later
    const result = inspectSessionRitual(root, {
      tier: "gated",
      posture: "mutation",
      now: staleAt,
      runGit: fakeGit(root, { head }),
    });
    expect(result.code).toBe(1);
    expect(result.recoveryTier).toBe("rearm");
    expect(result.message).toContain("session:start --rearm");
    expect(result.message).toContain("older than");
  });

  it("missing state inspect prefers cold recovery tier", () => {
    const root = tempRoot();
    const result = inspectSessionRitual(root, {
      tier: "gated",
      posture: "mutation",
      runGit: fakeGit(root),
    });
    expect(result.code).toBe(1);
    expect(result.recoveryTier).toBe("cold");
    expect(result.message).toContain("session:start");
    expect(result.message).not.toContain("--rearm");
  });

  it("worktree mismatch inspect prefers cold recovery", () => {
    const root = tempRoot();
    const head = "1111111111111111111111111111111111111111";
    seedRitual(root, {
      head,
      startedAt: new Date("2026-07-20T12:00:00Z"),
      worktree: "/old/tree",
    });
    const result = inspectSessionRitual(root, {
      tier: "gated",
      posture: "mutation",
      now: new Date("2026-07-20T12:30:00Z"),
      runGit: fakeGit(root, { head, worktree: root }),
    });
    expect(result.code).toBe(1);
    expect(result.recoveryTier).toBe("cold");
    expect(result.message).toContain("different worktree");
    expect(result.message).toContain("full cold");
  });

  it("compact marks rearm_needed and denial prefers re-arm recovery", () => {
    const root = tempRoot();
    const head = "2222222222222222222222222222222222222222";
    seedRitual(root, { head, startedAt: new Date("2026-07-20T12:00:00Z") });

    const compact = markRitualStaleAfterCompact(root, {
      now: new Date("2026-07-20T12:30:00Z"),
    });
    expect(compact.changed).toBe(true);
    expect(compact.message).toContain("re-arm");
    expect(compact.message).toContain("session:start --rearm");

    const raw = JSON.parse(readFileSync(join(root, ".deft", "ritual-state.json"), "utf8")) as {
      rearm_needed?: boolean;
      compact_resume_at?: string;
    };
    expect(raw.rearm_needed).toBe(true);
    expect(typeof raw.compact_resume_at).toBe("string");

    const denied = decideHook(
      {
        host: "cursor",
        event: "tool.before",
        projectRoot: root,
        payload: { tool_name: "Write", workspace_roots: [root] },
      },
      {
        inspectRitual: () =>
          inspectSessionRitual(root, {
            tier: "gated",
            posture: "mutation",
            now: new Date("2026-07-20T12:30:00Z"),
            runGit: fakeGit(root, { head }),
          }),
      },
    );
    expect(denied).toMatchObject({ verdict: "deny", code: "ritual-not-ready" });
    expect(denied.message).toContain("session:start --rearm");
    expect(denied.message).toContain("verify:session-ritual");
  });

  it("cold path still records ceremony_tier cold", () => {
    const root = tempRoot();
    const result = runSessionStart(root, {
      writeHistory: false,
      runGit: fakeGit(root),
      verifyTools: () => ({ exitCode: 0 }),
      runTriageWelcome: () => ({ exitCode: 0 }),
      runStalenessTickler: () => ({ lines: [], prompted: false }),
      resolveUserMd: () => ({
        path: join(root, "USER.md"),
        rung: "workspace-local",
        found: true,
        diagnostic: "ok",
        searched: [],
      }),
      probeEnvironment: () => environment,
      // #3286: hermetic orientation stubs (avoid live doctor / cache in unit test)
      orientationOptions: {
        doctorSection: {
          name: "doctor",
          status: "ok",
          ok: true,
          exitCode: 0,
          lines: ["[deft doctor] status: ok"],
          shaMatch: false,
          durationMs: 0,
        },
        agentsRefreshSection: {
          name: "agents_refresh",
          status: "ok",
          ok: true,
          exitCode: 0,
          lines: ["agents:refresh stub"],
          shaMatch: false,
          durationMs: 0,
        },
        cacheFreshSection: {
          name: "cache_fresh",
          status: "ok",
          ok: true,
          exitCode: 0,
          lines: ["cache-fresh stub"],
          shaMatch: false,
          durationMs: 0,
        },
        toolchainPreflight: {
          status: "ok",
          ok: true,
          degraded: false,
          findings: [],
          lines: ["[deft preflight] toolchain status: ok"],
          skipGateIds: [],
        },
      },
    });
    expect(result.code).toBe(0);
    expect(result.payload.ceremony_tier).toBe("cold");
  });
});
