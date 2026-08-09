import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearRegistryCache, DEFAULT_EVENT_LOG, readEvents } from "../lifecycle/events.js";
import type { EnvironmentContext } from "../platform/shell-context.js";
import type { ResolveUserMdResult } from "../user-config/resolve-user-md.js";
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
      "branch_policy",
      "verify_tools",
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
  it("records standard dial by default and keeps fat path", () => {
    const root = tempRoot();
    let toolsCalled = false;
    const result = runSessionStart(root, {
      ...baseOptions(root, () => userMdResult()),
      verifyTools: () => {
        toolsCalled = true;
        return { exitCode: 0 };
      },
      runStalenessTickler: () => ({ lines: [], prompted: false }),
    });
    expect(result.code).toBe(0);
    expect(result.lines.join("\n")).toContain("[deft ceremony-dial] depth=standard");
    const dial = result.payload.ceremony_dial as { depth: string; source: string };
    expect(dial.depth).toBe("standard");
    expect(toolsCalled).toBe(true);
    const state = JSON.parse(readFileSync(ritualStatePath(root), "utf8")) as {
      ceremony_dial: { depth: string };
    };
    expect(state.ceremony_dial.depth).toBe("standard");
  });

  it("S × frontier selects rapid, skips fat path, defers heavy steps", () => {
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
    expect(toolsCalled).toBe(false);
    expect(triageCalled).toBe(false);
    const steps = result.payload.steps as SessionStartStepTiming[];
    expect(steps.find((s) => s.name === "verify_tools")?.skipped).toBe(true);
    expect(steps.find((s) => s.name === "triage_welcome")?.skipped).toBe(true);
    const quick = result.payload.quick_steps as {
      triage_welcome: { deferred_reason?: string };
    };
    expect(quick.triage_welcome.deferred_reason).toMatch(/ceremony-dial/);
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
});
