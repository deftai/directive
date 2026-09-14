import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EnvironmentContext } from "../platform/shell-context.js";
import { selectCeremonyDepth } from "../policy/ceremony-dial.js";
import type { ResolveUserMdResult } from "../user-config/resolve-user-md.js";
import type { ApplyOccupancyInput, OccupancyDecision } from "./occupancy.js";
import { persistTrustedSessionPosture, sessionPosturePath } from "./posture.js";
import { ritualStatePath } from "./ritual-sentinel.js";
import {
  READ_ONLY_POSTURE,
  READ_ONLY_RESULT_MESSAGE,
  REQUIREMENTS_POSTURE,
  REQUIREMENTS_RESULT_MESSAGE,
  runSessionStart,
} from "./session-start.js";

/** Full ceremony — fat-path assertions must not use two-stage cold rapid default. */
const STANDARD_DIAL = selectCeremonyDepth({
  config: { enabled: true, override: "standard" },
});

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
  const root = mkdtempSync(join(tmpdir(), "session-read-only-"));
  temps.push(root);
  return root;
}

function userMdResult(overrides: Partial<ResolveUserMdResult> = {}): ResolveUserMdResult {
  return {
    path: "/home/x/.config/deft/USER.md",
    rung: "platform-config",
    found: true,
    diagnostic: "USER.md resolved from platform config dir",
    searched: [],
    ...overrides,
  };
}

describe("runSessionStart read-only posture (#2176)", () => {
  it("records alignment only and writes no ritual-state", () => {
    const root = tempRoot();
    let releaseProbeCalls = 0;
    const result = runSessionStart(root, {
      posture: READ_ONLY_POSTURE,
      resolveUserMd: () => userMdResult({ path: "/opt/USER.md", rung: "env-override" }),
      probeEnvironment: () => environment,
      probeReleaseAvailability: () => {
        releaseProbeCalls += 1;
        return { lines: ["unexpected release probe"] };
      },
    });
    expect(result.code).toBe(0);
    expect(result.payload.posture).toBe(READ_ONLY_POSTURE);
    expect(result.payload.state_path).toBeNull();
    expect(result.payload.message).toBe(READ_ONLY_RESULT_MESSAGE);
    expect(existsSync(ritualStatePath(root))).toBe(false);
    expect(existsSync(sessionPosturePath(root))).toBe(false);
    expect(result.lines.join("\n")).toContain("Deft Directive active");
    expect(result.lines.join("\n")).toContain("USER.md resolved (env-override)");
    expect(result.lines.join("\n")).toContain("[deft environment] os=darwin; shell=zsh");
    expect(result.lines.join("\n")).not.toContain("[deft policy]");
    expect(result.lines.join("\n")).not.toContain("[welcome]");
    expect(releaseProbeCalls).toBe(0);
    expect(result.payload.environment).toEqual({
      host_platform: "darwin",
      shell: { name: "zsh", path: "/bin/zsh", kind: "default", source: "SHELL" },
    });
  });

  const probeScmOk = () => ({
    ready: true as const,
    binary: "gh" as const,
    binaryPath: "/usr/bin/gh",
    authState: "authenticated" as const,
    githubAuthMode: "host-gh",
    runtimeMode: "local-unsandboxed",
    injectedTokenPresent: false,
    depth: "shallow" as const,
    detail: "SCM ready: gh present, host-gh authenticated (shallow)",
    remediation: null,
    skippedGates: [] as string[],
    login: null,
    failureKind: null,
  });

  it("mutation posture still writes ritual-state by default", () => {
    const root = tempRoot();
    const result = runSessionStart(root, {
      writeHistory: false,
      resolveUserMd: () => userMdResult(),
      verifyTools: () => ({ exitCode: 0 }),
      runTriageWelcome: () => ({ exitCode: 0 }),
      probeEnvironment: () => environment,
      probeScm: probeScmOk,
      ceremonyDial: STANDARD_DIAL,
      allowOptionalNetwork: true,
      probeReleaseAvailability: () => ({
        lines: ["[deft release] Newer Directive release available: v1.0.1"],
      }),
      runGit: (_r, args) => {
        if (args[0] === "rev-parse" && args.includes("HEAD")) {
          return { code: 0, stdout: "abc123", stderr: "" };
        }
        if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
          return { code: 0, stdout: root, stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "" };
      },
    });
    expect(result.code).toBe(0);
    expect(result.payload.posture).toBeUndefined();
    expect(existsSync(ritualStatePath(root))).toBe(true);
    expect(result.lines.join("\n")).toContain("Newer Directive release available");
  });

  it("mutation hot path skips release probe by default and still writes ritual-state (#2991)", () => {
    const root = tempRoot();
    let releaseProbeCalls = 0;
    const result = runSessionStart(root, {
      writeHistory: false,
      resolveUserMd: () => userMdResult(),
      verifyTools: () => ({ exitCode: 0 }),
      runTriageWelcome: () => ({ exitCode: 0 }),
      probeEnvironment: () => environment,
      probeScm: probeScmOk,
      ceremonyDial: STANDARD_DIAL,
      probeReleaseAvailability: () => {
        releaseProbeCalls += 1;
        return { lines: ["unexpected release probe"] };
      },
      runGit: (_r, args) => {
        if (args[0] === "rev-parse" && args.includes("HEAD")) {
          return { code: 0, stdout: "abc123", stderr: "" };
        }
        if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
          return { code: 0, stdout: root, stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "" };
      },
    });
    expect(result.code).toBe(0);
    expect(existsSync(ritualStatePath(root))).toBe(true);
    expect(releaseProbeCalls).toBe(0);
    expect(result.payload.optional_network).toBe(false);
    expect(result.lines.join("\n")).toContain("optional network skipped");
    const steps = result.payload.steps as Array<{
      name: string;
      duration_ms: number;
      skipped?: boolean;
    }>;
    expect(steps.map((s) => s.name)).toEqual([
      "alignment",
      "scm_readiness",
      "host_content_surface",
      "effort_budget",
      "lifecycle_visible",
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
    expect(steps.find((s) => s.name === "release_probe")?.skipped).toBe(true);
    expect(typeof result.payload.duration_ms).toBe("number");
  });
  it("does not clear another occupant requirements posture file", () => {
    const root = tempRoot();
    persistTrustedSessionPosture(root, "requirements", "owner-a");
    const result = runSessionStart(root, {
      posture: READ_ONLY_POSTURE,
      resolveUserMd: () => userMdResult(),
      probeEnvironment: () => environment,
    });
    expect(result.code).toBe(0);
    expect(existsSync(sessionPosturePath(root))).toBe(true);
  });
});

describe("runSessionStart requirements posture (#4444)", () => {
  it("claims occupancy, writes no ritual-state, and skips gated ceremony", () => {
    const root = tempRoot();
    const result = runSessionStart(root, {
      posture: REQUIREMENTS_POSTURE,
      sessionId: "host:test:v1:abc",
      resolveUserMd: () => userMdResult(),
      probeEnvironment: () => environment,
      applyOccupancy: (_projectRoot, input) => ({
        action: "claimed",
        sessionId: input.sessionId ?? "host:test:v1:abc",
        record: null,
        path: "/tmp/occupancy.json",
        message: "occupancy claimed",
        code: 0,
      }),
    });
    expect(result.code).toBe(0);
    expect(result.payload.posture).toBe(REQUIREMENTS_POSTURE);
    expect(result.payload.message).toBe(REQUIREMENTS_RESULT_MESSAGE);
    expect(existsSync(ritualStatePath(root))).toBe(false);
    expect(existsSync(sessionPosturePath(root))).toBe(true);
    expect(result.lines.join("\n")).toContain("DEFT_SESSION_POSTURE=requirements");
  });
});

describe("runSessionStart mutation posture vs persisted requirements (#4444)", () => {
  function deniedOccupancy(sessionId: string): OccupancyDecision {
    return {
      action: "denied",
      sessionId,
      record: null,
      path: "/tmp/occupancy.json",
      message: "occupancy denied",
      code: 1,
    };
  }

  function claimedOccupancy(input: ApplyOccupancyInput): OccupancyDecision {
    const resolved = input.sessionId ?? "host:test:v1:mutation";
    return {
      action: "claimed",
      sessionId: resolved,
      record: null,
      path: "/tmp/occupancy.json",
      message: "occupancy claimed",
      code: 0,
    };
  }

  const mutationGit = (root: string) => (_r: string, args: readonly string[]) => {
    if (args[0] === "rev-parse" && args.includes("HEAD")) {
      return { code: 0, stdout: "abc123", stderr: "" };
    }
    if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
      return { code: 0, stdout: root, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "" };
  };

  it("does not clear another occupant posture file when occupancy denies", () => {
    const root = tempRoot();
    persistTrustedSessionPosture(root, "requirements", "owner-a");
    const result = runSessionStart(root, {
      writeHistory: false,
      sessionId: "host:test:v1:challenger",
      resolveUserMd: () => userMdResult(),
      verifyTools: () => ({ exitCode: 0 }),
      runTriageWelcome: () => ({ exitCode: 0 }),
      probeEnvironment: () => environment,
      ceremonyDial: STANDARD_DIAL,
      applyOccupancy: () => deniedOccupancy("host:test:v1:challenger"),
      runGit: mutationGit(root),
      runStalenessTickler: () => ({ lines: [], prompted: false }),
    });
    expect(result.code).toBe(1);
    expect(existsSync(sessionPosturePath(root))).toBe(true);
  });

  it("clears persisted requirements posture after occupancy admission", () => {
    const root = tempRoot();
    persistTrustedSessionPosture(root, "requirements", "owner-a");
    const result = runSessionStart(root, {
      writeHistory: false,
      sessionId: "host:test:v1:mutation",
      resolveUserMd: () => userMdResult(),
      verifyTools: () => ({ exitCode: 0 }),
      runTriageWelcome: () => ({ exitCode: 0 }),
      probeEnvironment: () => environment,
      ceremonyDial: STANDARD_DIAL,
      applyOccupancy: (_projectRoot, input) => claimedOccupancy(input),
      runGit: mutationGit(root),
      runStalenessTickler: () => ({ lines: [], prompted: false }),
    });
    expect(result.code).toBe(0);
    expect(existsSync(sessionPosturePath(root))).toBe(false);
  });

  it("failed overlay clear after mutation ready keeps occupant posture", () => {
    const root = tempRoot();
    persistTrustedSessionPosture(root, "requirements", "host:test:v1:mutation");
    const result = runSessionStart(root, {
      writeHistory: false,
      sessionId: "host:test:v1:mutation",
      resolveUserMd: () => userMdResult(),
      verifyTools: () => ({ exitCode: 0 }),
      runTriageWelcome: () => ({ exitCode: 0 }),
      probeEnvironment: () => environment,
      ceremonyDial: STANDARD_DIAL,
      applyOccupancy: (_projectRoot, input) => claimedOccupancy(input),
      runGit: mutationGit(root),
      runStalenessTickler: () => ({ lines: [], prompted: false }),
      clearSessionPosture: () => {
        throw new Error("overlay locked");
      },
    });
    expect(result.code).toBe(2);
    expect(result.payload.ready).toBe(false);
    expect(String(result.payload.message)).toBe("session ritual failed");
    expect(result.lines.join("\n")).toContain("overlay locked");
    expect(existsSync(sessionPosturePath(root))).toBe(true);
  });

  it("failed mutation ritual write keeps occupant posture", () => {
    const root = tempRoot();
    persistTrustedSessionPosture(root, "requirements", "host:test:v1:mutation");
    expect(() =>
      runSessionStart(root, {
        writeHistory: false,
        sessionId: "host:test:v1:mutation",
        resolveUserMd: () => userMdResult(),
        verifyTools: () => ({ exitCode: 0 }),
        runTriageWelcome: () => ({ exitCode: 0 }),
        probeEnvironment: () => environment,
        ceremonyDial: STANDARD_DIAL,
        applyOccupancy: (_projectRoot, input) => claimedOccupancy(input),
        runGit: mutationGit(root),
        runStalenessTickler: () => ({ lines: [], prompted: false }),
        writeRitualState: () => {
          throw new Error("ritual write failed");
        },
      }),
    ).toThrow(/ritual-state persistence failed/);
    expect(existsSync(sessionPosturePath(root))).toBe(true);
  });
});

describe("runSessionStart requirements persist-fail occupancy rollback (#4444)", () => {
  it("releases a new occupancy claim when posture persist fails", () => {
    const root = tempRoot();
    const released: Array<{ sessionId?: string }> = [];
    const result = runSessionStart(root, {
      posture: REQUIREMENTS_POSTURE,
      sessionId: "host:test:v1:abc",
      resolveUserMd: () => userMdResult(),
      probeEnvironment: () => environment,
      applyOccupancy: (_projectRoot, input) => ({
        action: "claimed",
        sessionId: input.sessionId ?? "host:test:v1:abc",
        record: null,
        path: join(root, ".deft", "occupancy.json"),
        message: "occupancy claimed",
        code: 0,
      }),
      persistSessionPosture: () => {
        throw new Error("disk full");
      },
      releaseOccupancy: (_projectRoot, input) => {
        released.push(input);
        return {
          action: "released",
          sessionId: String(input.sessionId),
          record: null,
          path: join(root, ".deft", "occupancy.json"),
          message: "occupancy released",
          code: 0,
        };
      },
    });
    expect(result.code).toBe(1);
    expect(String(result.payload.message)).toContain("disk full");
    expect(released).toHaveLength(1);
    expect(released[0]?.sessionId).toBe("host:test:v1:abc");
  });

  it("does not release an existing heartbeat when posture persist fails", () => {
    const root = tempRoot();
    const released: unknown[] = [];
    const result = runSessionStart(root, {
      posture: REQUIREMENTS_POSTURE,
      sessionId: "host:test:v1:abc",
      resolveUserMd: () => userMdResult(),
      probeEnvironment: () => environment,
      applyOccupancy: (_projectRoot, input) => ({
        action: "heartbeat",
        sessionId: input.sessionId ?? "host:test:v1:abc",
        record: null,
        path: join(root, ".deft", "occupancy.json"),
        message: "occupancy heartbeat",
        code: 0,
      }),
      persistSessionPosture: () => {
        throw new Error("disk full");
      },
      releaseOccupancy: (_projectRoot, input) => {
        released.push(input);
        return {
          action: "released",
          sessionId: String(input.sessionId),
          record: null,
          path: join(root, ".deft", "occupancy.json"),
          message: "occupancy released",
          code: 0,
        };
      },
    });
    expect(result.code).toBe(1);
    expect(String(result.payload.message)).toBe("disk full");
    expect(released).toHaveLength(0);
  });
});
