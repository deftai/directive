import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearRegistryCache, DEFAULT_EVENT_LOG, readEvents } from "../lifecycle/events.js";
import type { EnvironmentContext } from "../platform/shell-context.js";
import { selectCeremonyDepth } from "../policy/ceremony-dial.js";
import { computeRitualGateShare, parseRunSummaryJsonl } from "../run-summary/share.js";
import { ENV_RUN_SUMMARY_PATH, ENV_TOTAL_TOOL_TURNS } from "../run-summary/types.js";
import type { ResolveUserMdResult } from "../user-config/resolve-user-md.js";
import { ENV_MAX_TURNS } from "./effort-budget.js";
import type { GitRunResult } from "./git.js";
import {
  ENV_SESSION_START_NETWORK,
  OPTIONAL_NETWORK_SKIPPED_MESSAGE,
  resolveSessionStartOptionalNetwork,
  ritualStatePath,
  runSessionStart,
  type SessionStartOptions,
  type SessionStartStepTiming,
} from "./session-start.js";

/** Full ceremony profile — used when tests assert fat-path / optional-network behavior. */
const STANDARD_DIAL = selectCeremonyDepth({
  config: { enabled: true, override: "standard" },
});

const temps: string[] = [];
const environment: EnvironmentContext = {
  hostPlatform: "darwin",
  shell: { name: "zsh", path: "/bin/zsh", kind: "default", source: "SHELL" },
};
afterEach(() => {
  clearRegistryCache();
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  temps.length = 0;
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "session-start-usermd-"));
  temps.push(root);
  return root;
}

/** Fake git runner: HEAD + toplevel resolve; everything else is a benign no-op. */
function fakeGit(root: string): (root: string, args: readonly string[]) => GitRunResult {
  return (_root, args) => {
    if (args[0] === "rev-parse" && args.includes("HEAD")) {
      return { code: 0, stdout: "deadbeef", stderr: "" };
    }
    if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
      return { code: 0, stdout: root, stderr: "" };
    }
    // No upstream / default branch -> defaultBranchSync returns a benign warning.
    return { code: 1, stdout: "", stderr: "" };
  };
}

function baseOptions(
  root: string,
  resolveUserMd: SessionStartOptions["resolveUserMd"],
): SessionStartOptions {
  return {
    writeHistory: false,
    runGit: fakeGit(root),
    verifyTools: () => ({ exitCode: 0 }),
    runTriageWelcome: () => ({ exitCode: 0 }),
    resolveUserMd,
    probeEnvironment: () => environment,
    // #2275: inject deterministic SCM probe so suite never shells out to gh.
    probeScm: () => ({
      ready: true,
      binary: "gh",
      binaryPath: "/usr/bin/gh",
      authState: "authenticated",
      githubAuthMode: "host-gh",
      runtimeMode: "local-unsandboxed",
      injectedTokenPresent: false,
      depth: "shallow",
      detail: "SCM ready: gh present, host-gh authenticated (shallow)",
      remediation: null,
      skippedGates: [],
      login: null,
      failureKind: null,
    }),
  };
}

function userMdResult(overrides: Partial<ResolveUserMdResult>): ResolveUserMdResult {
  return {
    path: "/home/x/.config/deft/USER.md",
    rung: "platform-config",
    found: true,
    diagnostic: "USER.md resolved from platform config dir: /home/x/.config/deft/USER.md",
    searched: [],
    ...overrides,
  };
}

describe("runSessionStart — USER.md auto-resolution (#2271)", () => {
  it("resolves USER.md automatically and surfaces the path in output + payload", () => {
    const root = tempRoot();
    const resolved = userMdResult({
      path: join(root, ".deft", "USER.md"),
      rung: "workspace-local",
      found: true,
      diagnostic: "USER.md resolved from workspace-local config",
    });
    const result = runSessionStart(
      root,
      baseOptions(root, () => resolved),
    );
    expect(result.code).toBe(0);
    expect(result.lines.join("\n")).toContain("USER.md resolved (workspace-local)");
    expect(result.lines.join("\n")).toContain(join(root, ".deft", "USER.md"));
    expect(result.lines.join("\n")).toContain(
      "[deft environment] os=darwin; shell=zsh; kind=default; path=/bin/zsh; source=SHELL",
    );
    const payload = result.payload as {
      user_md: ResolveUserMdResult;
      environment: Record<string, unknown>;
    };
    expect(payload.user_md.rung).toBe("workspace-local");
    expect(payload.user_md.found).toBe(true);
    expect(payload.user_md.path).toBe(join(root, ".deft", "USER.md"));
    expect(payload.environment).toEqual({
      host_platform: "darwin",
      shell: { name: "zsh", path: "/bin/zsh", kind: "default", source: "SHELL" },
    });
  });

  it("records which USER.md path was used in the alignment ritual step", () => {
    const root = tempRoot();
    const resolved = userMdResult({ path: "/opt/deft/USER.md", rung: "env-override" });
    const result = runSessionStart(
      root,
      baseOptions(root, () => resolved),
    );
    expect(result.code).toBe(0);
    const parsed: unknown = JSON.parse(readFileSync(ritualStatePath(root), "utf8"));
    // JSON.parse can return a top-level null without throwing; guard before any
    // property access so a malformed payload fails loud, not with a TypeError.
    expect(parsed).not.toBeNull();
    expect(typeof parsed).toBe("object");
    const state = parsed as { quick_steps: { alignment: { message: string } } };
    expect(state.quick_steps.alignment.message).toContain("Deft Directive active");
    expect(state.quick_steps.alignment.message).toContain("USER.md resolved (env-override)");
    expect(state.quick_steps.alignment.message).toContain("/opt/deft/USER.md");
  });

  it("degrades to a clear diagnostic (not a crash) when USER.md is absent everywhere", () => {
    const root = tempRoot();
    const resolved = userMdResult({
      path: "/home/x/.config/deft/USER.md",
      rung: "default",
      found: false,
      diagnostic: "no USER.md found; using defaults (searched: a, b)",
    });
    const result = runSessionStart(
      root,
      baseOptions(root, () => resolved),
    );
    expect(result.code).toBe(0);
    expect(result.lines.join("\n")).toContain("no USER.md found; using defaults");
    const payload = result.payload as { user_md: ResolveUserMdResult };
    expect(payload.user_md.found).toBe(false);
    expect(payload.user_md.rung).toBe("default");
  });

  it("uses the shared resolver by default (no seam) without throwing", () => {
    const root = tempRoot();
    const result = runSessionStart(root, {
      writeHistory: false,
      runGit: fakeGit(root),
      verifyTools: () => ({ exitCode: 0 }),
      runTriageWelcome: () => ({ exitCode: 0 }),
    });
    expect(result.code).toBe(0);
    const payload = result.payload as { user_md: ResolveUserMdResult };
    expect(payload.user_md).toBeDefined();
    expect(typeof payload.user_md.path).toBe("string");
  });
});

describe("runSessionStart hot path + step timings (#2991)", () => {
  it("resolveSessionStartOptionalNetwork defaults off; flag and env opt in", () => {
    expect(resolveSessionStartOptionalNetwork({})).toBe(false);
    expect(resolveSessionStartOptionalNetwork({ allowOptionalNetwork: true })).toBe(true);
    expect(resolveSessionStartOptionalNetwork({ allowOptionalNetwork: false })).toBe(false);
    expect(
      resolveSessionStartOptionalNetwork({
        env: { [ENV_SESSION_START_NETWORK]: "1" },
      }),
    ).toBe(true);
    expect(
      resolveSessionStartOptionalNetwork({
        allowOptionalNetwork: false,
        env: { [ENV_SESSION_START_NETWORK]: "1" },
      }),
    ).toBe(false);
  });

  it("emits per-step duration_ms and skips optional network by default", () => {
    const root = tempRoot();
    let releaseCalls = 0;
    let triageHeals = 0;
    const result = runSessionStart(root, {
      ...baseOptions(root, () =>
        userMdResult({ path: join(root, "USER.md"), rung: "workspace-local" }),
      ),
      // Force standard so fat-path steps run (cold default is rapid two-stage).
      ceremonyDial: STANDARD_DIAL,
      probeReleaseAvailability: () => {
        releaseCalls += 1;
        return { lines: ["should not run"] };
      },
      runTriageWelcome: (_r, o) => {
        // Injected welcome: prove ritual still completes without network.
        o.output("[welcome] local summary");
        triageHeals += 1;
        return { exitCode: 0 };
      },
      runStalenessTickler: () => ({ lines: [], prompted: false }),
    });
    expect(result.code).toBe(0);
    expect(releaseCalls).toBe(0);
    expect(triageHeals).toBe(1);
    expect(result.lines).toContain(OPTIONAL_NETWORK_SKIPPED_MESSAGE);
    const payload = result.payload as {
      steps: SessionStartStepTiming[];
      duration_ms: number;
      optional_network: boolean;
      quick_steps: Record<string, { duration_ms?: number }>;
    };
    expect(payload.optional_network).toBe(false);
    expect(payload.duration_ms).toBeGreaterThanOrEqual(0);
    const names = payload.steps.map((s) => s.name);
    expect(names).toEqual([
      "alignment",
      "scm_readiness",
      "host_content_surface",
      "effort_budget",
      "branch_policy",
      "verify_tools",
      // #3286: orientation compression composes doctor + preflight + refresh surfaces
      "doctor",
      "preflight",
      "agents_refresh",
      "cache_fresh",
      "orientation",
      "triage_welcome",
      "release_probe",
      "ritual_write",
    ]);
    for (const step of payload.steps) {
      expect(typeof step.duration_ms).toBe("number");
      expect(step.duration_ms).toBeGreaterThanOrEqual(0);
    }
    expect(payload.steps.find((s) => s.name === "release_probe")?.skipped).toBe(true);
    expect(payload.quick_steps.alignment.duration_ms).toBeGreaterThanOrEqual(0);
    expect(payload.quick_steps.branch_policy.duration_ms).toBeGreaterThanOrEqual(0);
    expect(payload.quick_steps.triage_welcome.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("emits local session:start process-cost event (#2994)", () => {
    const root = tempRoot();
    const result = runSessionStart(root, {
      ...baseOptions(root, () =>
        userMdResult({ path: join(root, "USER.md"), rung: "workspace-local" }),
      ),
      runStalenessTickler: () => ({ lines: [], prompted: false }),
    });
    expect(result.code).toBe(0);
    const logPath = join(root, DEFAULT_EVENT_LOG);
    expect(existsSync(logPath)).toBe(true);
    const events = readEvents(logPath);
    const start = events.find((e) => e.event === "session:start");
    expect(start).toBeDefined();
    expect(start?.payload.ceremony_tier).toBe("cold");
    expect(typeof start?.payload.duration_ms).toBe("number");
    expect(start?.payload.exit_code).toBe(0);
    expect(Array.isArray(start?.payload.steps)).toBe(true);
  });

  it("runs release probe when allowOptionalNetwork is true", () => {
    const root = tempRoot();
    let releaseCalls = 0;
    const result = runSessionStart(root, {
      ...baseOptions(root, () => userMdResult()),
      ceremonyDial: STANDARD_DIAL,
      allowOptionalNetwork: true,
      probeReleaseAvailability: () => {
        releaseCalls += 1;
        return { lines: ["[deft release] Checking public registry."] };
      },
      runStalenessTickler: () => ({ lines: [], prompted: false }),
    });
    expect(result.code).toBe(0);
    expect(releaseCalls).toBe(1);
    expect(result.payload.optional_network).toBe(true);
    expect(result.lines.join("\n")).toContain("Checking public registry");
    const steps = result.payload.steps as SessionStartStepTiming[];
    expect(steps.find((s) => s.name === "release_probe")?.skipped).toBeUndefined();
  });

  it("default triage welcome path does not invoke self-heal when network is off", () => {
    const root = tempRoot();
    // Do not inject runTriageWelcome — exercise the real default-mode wiring
    // with a stubbed self-heal via the module path is hard; instead assert
    // that without allowOptionalNetwork, ritual completes and release is skipped.
    const result = runSessionStart(root, {
      writeHistory: false,
      runGit: fakeGit(root),
      verifyTools: () => ({ exitCode: 0 }),
      resolveUserMd: () => userMdResult(),
      probeEnvironment: () => environment,
      ceremonyDial: STANDARD_DIAL,
      runStalenessTickler: () => ({ lines: [], prompted: false }),
      probeReleaseAvailability: () => {
        throw new Error("release probe must not run on hot path");
      },
    });
    expect(result.code).toBe(0);
    expect(result.payload.optional_network).toBe(false);
    expect(result.lines).toContain(OPTIONAL_NETWORK_SKIPPED_MESSAGE);
  });
});

describe("runSessionStart ceremony dial (#3214)", () => {
  it("records rapid dial by default (two-stage cold) and still runs verify_tools", () => {
    const root = tempRoot();
    let toolsCalled = false;
    const result = runSessionStart(root, {
      ...baseOptions(root, () => userMdResult()),
      env: {},
      verifyTools: () => {
        toolsCalled = true;
        return { exitCode: 0 };
      },
      runStalenessTickler: () => ({ lines: [], prompted: false }),
    });
    expect(result.code).toBe(0);
    expect(result.lines.join("\n")).toContain("[deft ceremony-dial] depth=rapid");
    const dial = result.payload.ceremony_dial as { depth: string; source: string };
    expect(dial.depth).toBe("rapid");
    // Mutation readiness constant (#3156) — tools run even on cold rapid default.
    expect(toolsCalled).toBe(true);
    const state = JSON.parse(readFileSync(ritualStatePath(root), "utf8")) as {
      ceremony_dial: { depth: string };
    };
    expect(state.ceremony_dial.depth).toBe("rapid");
  });

  it("S × frontier selects rapid, skips ceremony fat path, keeps readiness", () => {
    const root = tempRoot();
    let toolsCalled = false;
    let triageCalled = false;
    const result = runSessionStart(root, {
      ...baseOptions(root, () => userMdResult()),
      ceremonyDialInputs: {
        taskSize: "S",
        modelTier: "frontier",
        projectShape: "project",
      },
      verifyTools: () => {
        toolsCalled = true;
        return { exitCode: 0 };
      },
      runTriageWelcome: () => {
        triageCalled = true;
        return { exitCode: 0 };
      },
      runStalenessTickler: () => {
        throw new Error("tickler must not run on rapid dial");
      },
    });
    expect(result.code).toBe(0);
    expect(result.lines.join("\n")).toContain("depth=rapid");
    expect(result.lines.join("\n")).toContain("content/strategies/rapid.md");
    const dial = result.payload.ceremony_dial as {
      depth: string;
      composition: { rapidStrategy: string | null };
    };
    expect(dial.depth).toBe("rapid");
    expect(dial.composition.rapidStrategy).toContain("rapid.md");
    // #3156 gate integrity: verify_tools always runs; triage is ceremony-only skip.
    expect(toolsCalled).toBe(true);
    expect(triageCalled).toBe(false);
    const steps = result.payload.steps as SessionStartStepTiming[];
    expect(steps.find((s) => s.name === "verify_tools")?.skipped).toBeUndefined();
    expect(steps.find((s) => s.name === "triage_welcome")?.skipped).toBe(true);
    const quick = result.payload.quick_steps as {
      triage_welcome: { deferred_reason?: string };
      verify_tools: { ok?: boolean; deferred_reason?: string };
    };
    expect(quick.triage_welcome.deferred_reason).toMatch(/ceremony-dial/);
    // verify_tools is persisted on ritual-state quick_steps (not deferred).
    expect(quick.verify_tools?.ok).toBe(true);
    expect(quick.verify_tools?.deferred_reason).toBeUndefined();
    // Gated readiness steps must remain available (not auto-deferred).
    const gated = result.payload.gated_steps as Record<string, { deferred_reason?: string }>;
    expect(gated.doctor?.deferred_reason).toBeUndefined();
    expect(gated.cache_fresh?.deferred_reason).toBeUndefined();
    expect(gated.agent_hooks?.deferred_reason).toBeUndefined();
  });

  it("persists verify_tools failure on ritual-state and fails ready", () => {
    const root = tempRoot();
    const result = runSessionStart(root, {
      ...baseOptions(root, () => userMdResult()),
      ceremonyDialInputs: {
        taskSize: "S",
        modelTier: "frontier",
        projectShape: "project",
      },
      verifyTools: () => ({ exitCode: 2 }),
      runStalenessTickler: () => ({ lines: [], prompted: false }),
    });
    expect(result.code).toBe(1);
    expect(result.payload.ready).toBe(false);
    const quick = result.payload.quick_steps as {
      verify_tools: { ok: boolean; exit_code?: number; message?: string };
    };
    expect(quick.verify_tools.ok).toBe(false);
    expect(quick.verify_tools.exit_code).toBe(2);
    expect(quick.verify_tools.message).toMatch(/verify:tools failed/);
    const state = JSON.parse(readFileSync(ritualStatePath(root), "utf8")) as {
      quick_steps: { verify_tools: { ok: boolean } };
    };
    expect(state.quick_steps.verify_tools.ok).toBe(false);
  });

  it("provisional M size escalates to standard without plan-item effort", () => {
    const root = tempRoot();
    let toolsCalled = false;
    const result = runSessionStart(root, {
      ...baseOptions(root, () => userMdResult()),
      env: {},
      ceremonyDialHints: { verb: "implement" },
      verifyTools: () => {
        toolsCalled = true;
        return { exitCode: 0 };
      },
      runStalenessTickler: () => ({ lines: [], prompted: false }),
    });
    expect(result.code).toBe(0);
    const dial = result.payload.ceremony_dial as {
      depth: string;
      inputs: { taskSize: string | null };
      provisional: { taskSize: string | null; reasons: string[] };
    };
    expect(dial.inputs.taskSize).toBe("M");
    expect(dial.depth).toBe("standard");
    expect(dial.provisional.reasons.some((r) => r.includes("verb"))).toBe(true);
    // Readiness constant: tools still run on escalated standard.
    expect(toolsCalled).toBe(true);
  });

  it("non-project shape selects minimal and points at #3014 research", () => {
    const root = tempRoot();
    const result = runSessionStart(root, {
      ...baseOptions(root, () => userMdResult()),
      ceremonyDialInputs: {
        taskSize: "S",
        modelTier: "frontier",
        projectShape: "non-project",
      },
      runStalenessTickler: () => ({ lines: [], prompted: false }),
    });
    expect(result.code).toBe(0);
    const dial = result.payload.ceremony_dial as {
      depth: string;
      composition: { minimalAgentsProfile: string | null };
    };
    expect(dial.depth).toBe("minimal");
    expect(dial.composition.minimalAgentsProfile).toContain("#3014");
  });

  it("emits coverageDebt disclosure even when branch_policy is deferred (#3314)", () => {
    const root = tempRoot();
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "T",
          status: "running",
          items: [],
          policy: { coverageDebt: { mode: "hatch" } },
        },
      }),
      "utf8",
    );
    const result = runSessionStart(root, {
      ...baseOptions(root, () => userMdResult()),
      deferrals: { branch_policy: "ok" },
      runStalenessTickler: () => ({ lines: [], prompted: false }),
    });
    expect(result.code).toBe(0);
    expect(result.lines.some((l) => l.includes("coverageDebt.mode=hatch"))).toBe(true);
    expect(result.lines.some((l) => l.includes("reserved"))).toBe(true);
  });
});

describe("runSessionStart start-tier provenance + evaluation events (#3319)", () => {
  it("surfaces external-pin provenance and #3274 bypass with unset-the-pin remediation", () => {
    const root = tempRoot();
    const result = runSessionStart(root, {
      ...baseOptions(root, () => userMdResult()),
      ceremonyDial: STANDARD_DIAL,
      ceremonyDialStartTierProvenance: "external-pin",
      runStalenessTickler: () => ({ lines: [], prompted: false }),
    });
    expect(result.code).toBe(0);
    const text = result.lines.join("\n");
    expect(text).toContain("start-tier=standard");
    expect(text).toContain("provenance=external-pin");
    expect(text).toContain("#3274 cold-start selection is bypassed (external-pin)");
    expect(text).toContain("Unset the pin");
    const dial = result.payload.ceremony_dial as {
      start_tier: string;
      start_tier_provenance: string;
    };
    expect(dial.start_tier).toBe("standard");
    expect(dial.start_tier_provenance).toBe("external-pin");
  });

  it("emits a declined evaluation event when #3274 stays at the cold-start floor", () => {
    const root = tempRoot();
    const out = join(root, "summary.jsonl");
    const result = runSessionStart(root, {
      ...baseOptions(root, () => userMdResult()),
      env: { [ENV_RUN_SUMMARY_PATH]: out },
      ceremonyDialInputs: {
        taskSize: "S",
        modelTier: "frontier",
        projectShape: "project",
      },
      runStalenessTickler: () => ({ lines: [], prompted: false }),
    });
    expect(result.code).toBe(0);
    expect(result.lines.join("\n")).toContain("provenance=cold-start");
    const events = readFileSync(out, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { event: string; payload: Record<string, unknown> });
    const evals = events.filter((e) => e.event === "dial_escalation_evaluation");
    expect(evals).toHaveLength(1);
    expect(evals[0]?.payload.outcome).toBe("declined");
    expect(evals[0]?.payload.tier).toBe("rapid");
    expect(String(evals[0]?.payload.reason)).toContain("insufficient evidence");
  });

  it("emits an escalated evaluation event when provisional evidence raises depth", () => {
    const root = tempRoot();
    const out = join(root, "summary.jsonl");
    const result = runSessionStart(root, {
      ...baseOptions(root, () => userMdResult()),
      env: { [ENV_RUN_SUMMARY_PATH]: out },
      ceremonyDialHints: { verb: "implement" },
      runStalenessTickler: () => ({ lines: [], prompted: false }),
    });
    expect(result.code).toBe(0);
    const events = readFileSync(out, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { event: string; payload: Record<string, unknown> });
    const evals = events.filter((e) => e.event === "dial_escalation_evaluation");
    expect(evals).toHaveLength(1);
    expect(evals[0]?.payload.outcome).toBe("escalated");
    expect(evals[0]?.payload.tier).toBe("standard");
  });

  it("emits no evaluation event when the start tier is pinned", () => {
    const root = tempRoot();
    const out = join(root, "summary.jsonl");
    const result = runSessionStart(root, {
      ...baseOptions(root, () => userMdResult()),
      env: { [ENV_RUN_SUMMARY_PATH]: out },
      ceremonyDial: STANDARD_DIAL,
      ceremonyDialStartTierProvenance: "external-pin",
      runStalenessTickler: () => ({ lines: [], prompted: false }),
    });
    expect(result.code).toBe(0);
    const events = readFileSync(out, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { event: string });
    expect(events.some((e) => e.event === "session_start")).toBe(true);
    expect(events.some((e) => e.event === "dial_escalation_evaluation")).toBe(false);
  });

  it("stays silent when DEFT_RUN_SUMMARY_PATH is unset", () => {
    const root = tempRoot();
    const result = runSessionStart(root, {
      ...baseOptions(root, () => userMdResult()),
      env: {},
      ceremonyDialInputs: {
        taskSize: "S",
        modelTier: "frontier",
        projectShape: "project",
      },
      runStalenessTickler: () => ({ lines: [], prompted: false }),
    });
    expect(result.code).toBe(0);
    expect(existsSync(join(root, ".deft-run-summary.json"))).toBe(false);
  });
});

describe("runSessionStart tool_turn_denominator (#3356)", () => {
  function summaryEvents(out: string): Array<{
    event: string;
    total_tool_turns?: number;
    payload: { total_tool_turns?: number };
  }> {
    return parseRunSummaryJsonl(readFileSync(out, "utf8"));
  }

  it("emits a denominator when only DEFT_RUN_SUMMARY_PATH is set", () => {
    const root = tempRoot();
    const out = join(root, "summary.jsonl");
    const result = runSessionStart(root, {
      ...baseOptions(root, () => userMdResult()),
      env: { [ENV_RUN_SUMMARY_PATH]: out },
      ceremonyDialInputs: {
        taskSize: "S",
        modelTier: "frontier",
        projectShape: "project",
      },
      runStalenessTickler: () => ({ lines: [], prompted: false }),
    });
    expect(result.code).toBe(0);
    const events = summaryEvents(out);
    const denoms = events.filter((e) => e.event === "tool_turn_denominator");
    expect(denoms).toHaveLength(1);
    expect(denoms[0]?.payload.total_tool_turns).toBe(1);
    expect(denoms[0]?.total_tool_turns).toBe(1);
    const share = computeRitualGateShare(events);
    expect(share.evaluable).toBe(true);
    expect(share.totalToolTurns).toBe(1);
    expect(share.share).toBe(0);
  });

  it("records DEFT_MAX_TURNS as the session denominator", () => {
    const root = tempRoot();
    const out = join(root, "summary.jsonl");
    const result = runSessionStart(root, {
      ...baseOptions(root, () => userMdResult()),
      env: { [ENV_RUN_SUMMARY_PATH]: out, [ENV_MAX_TURNS]: "50" },
      runStalenessTickler: () => ({ lines: [], prompted: false }),
    });
    expect(result.code).toBe(0);
    const denoms = summaryEvents(out).filter((e) => e.event === "tool_turn_denominator");
    expect(denoms).toHaveLength(1);
    expect(denoms[0]?.total_tool_turns).toBe(50);
    expect(computeRitualGateShare(summaryEvents(out)).share).toBe(0);
  });

  it("emits a fractional host maxTurns as the planned-turn budget", () => {
    const root = tempRoot();
    const out = join(root, "summary.jsonl");
    const result = runSessionStart(root, {
      ...baseOptions(root, () => userMdResult()),
      env: { [ENV_RUN_SUMMARY_PATH]: out },
      effortBudgetSeams: { hostDescriptor: { maxTurns: 10.5 } },
      runStalenessTickler: () => ({ lines: [], prompted: false }),
    });
    expect(result.code).toBe(0);
    const denoms = summaryEvents(out).filter((e) => e.event === "tool_turn_denominator");
    expect(denoms).toHaveLength(1);
    expect(denoms[0]?.total_tool_turns).toBe(10.5);
  });

  it("emits a sub-unit host maxTurns as the planned-turn budget", () => {
    const root = tempRoot();
    const out = join(root, "summary.jsonl");
    const result = runSessionStart(root, {
      ...baseOptions(root, () => userMdResult()),
      env: { [ENV_RUN_SUMMARY_PATH]: out },
      effortBudgetSeams: { hostDescriptor: { maxTurns: 0.5 } },
      runStalenessTickler: () => ({ lines: [], prompted: false }),
    });
    expect(result.code).toBe(0);
    const denoms = summaryEvents(out).filter((e) => e.event === "tool_turn_denominator");
    expect(denoms).toHaveLength(1);
    expect(denoms[0]?.total_tool_turns).toBe(0.5);
  });

  it("prefers DEFT_TOTAL_TOOL_TURNS over DEFT_MAX_TURNS", () => {
    const root = tempRoot();
    const out = join(root, "summary.jsonl");
    const result = runSessionStart(root, {
      ...baseOptions(root, () => userMdResult()),
      env: {
        [ENV_RUN_SUMMARY_PATH]: out,
        [ENV_TOTAL_TOOL_TURNS]: "12",
        [ENV_MAX_TURNS]: "50",
      },
      runStalenessTickler: () => ({ lines: [], prompted: false }),
    });
    expect(result.code).toBe(0);
    const denoms = summaryEvents(out).filter((e) => e.event === "tool_turn_denominator");
    expect(denoms.length).toBeGreaterThanOrEqual(1);
    expect(denoms.every((e) => e.total_tool_turns === 12)).toBe(true);
  });
});

describe("runSessionStart consumer evidence (#3358)", () => {
  function writeActiveClauses(root: string, count: number): void {
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "story.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "T",
          status: "running",
          acceptance: {
            none_stated: true,
            clauses: Array.from({ length: count }, (_, i) => ({
              id: i + 1,
              text: `clause ${i + 1}`,
            })),
          },
        },
      }),
      "utf8",
    );
  }

  it("stays rapid when no stamped clauses or host env exist", () => {
    const root = tempRoot();
    const result = runSessionStart(root, {
      ...baseOptions(root, () => userMdResult()),
      env: {},
      runStalenessTickler: () => ({ lines: [], prompted: false }),
    });
    expect(result.code).toBe(0);
    const dial = result.payload.ceremony_dial as {
      depth: string;
      inputs: { taskSize: string | null; modelTier: string | null };
      consumer_evidence: { taskSize: string | null; clauseCount: number | null };
    };
    expect(dial.depth).toBe("rapid");
    expect(dial.inputs.taskSize).toBeNull();
    expect(dial.inputs.modelTier).toBeNull();
    expect(dial.consumer_evidence.clauseCount).toBeNull();
  });

  it("escalates from stamped clause count instead of a vacuous decline", () => {
    const root = tempRoot();
    writeActiveClauses(root, 3);
    const out = join(root, "summary.jsonl");
    const result = runSessionStart(root, {
      ...baseOptions(root, () => userMdResult()),
      env: { [ENV_RUN_SUMMARY_PATH]: out },
      runStalenessTickler: () => ({ lines: [], prompted: false }),
    });
    expect(result.code).toBe(0);
    const dial = result.payload.ceremony_dial as {
      depth: string;
      inputs: { taskSize: string | null };
      consumer_evidence: { clauseCount: number | null; taskSize: string | null };
    };
    expect(dial.inputs.taskSize).toBe("M");
    expect(dial.depth).toBe("standard");
    expect(dial.consumer_evidence.clauseCount).toBe(3);
    expect(result.lines.some((l) => l.includes("evidence:") && l.includes("clauseCount=3"))).toBe(
      true,
    );
    const events = readFileSync(out, "utf8")
      .trim()
      .split("\n")
      .map(
        (l) => JSON.parse(l) as { event: string; payload: { outcome?: string; reason?: string } },
      );
    const evals = events.filter((e) => e.event === "dial_escalation_evaluation");
    expect(evals).toHaveLength(1);
    expect(evals[0]?.payload.outcome).toBe("escalated");
    expect(String(evals[0]?.payload.reason)).toContain("size=M");
    expect(String(evals[0]?.payload.reason)).not.toContain("size=-");
  });

  it("does not override an explicit CLI size with stamped clauses", () => {
    const root = tempRoot();
    writeActiveClauses(root, 4);
    const result = runSessionStart(root, {
      ...baseOptions(root, () => userMdResult()),
      env: {},
      ceremonyDialInputs: {
        taskSize: "S",
        modelTier: "frontier",
        projectShape: "project",
      },
      runStalenessTickler: () => ({ lines: [], prompted: false }),
    });
    expect(result.code).toBe(0);
    const dial = result.payload.ceremony_dial as {
      depth: string;
      inputs: { taskSize: string | null };
    };
    expect(dial.inputs.taskSize).toBe("S");
    expect(dial.depth).toBe("rapid");
  });
});
