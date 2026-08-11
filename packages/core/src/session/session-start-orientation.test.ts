import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EnvironmentContext } from "../platform/shell-context.js";
import { selectCeremonyDepth } from "../policy/ceremony-dial.js";
import type { ResolveUserMdResult } from "../user-config/resolve-user-md.js";
import type { GitRunResult } from "./git.js";
import type { OrientationBundle } from "./orientation-compression.js";
import { ORIENTATION_LATER_STATUS } from "./orientation-compression.js";
import { ritualStatePath } from "./ritual-sentinel.js";
import { READ_ONLY_POSTURE, runSessionStart, type SessionStartOptions } from "./session-start.js";

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
  const root = mkdtempSync(join(tmpdir(), "session-orient-"));
  temps.push(root);
  return root;
}

function fakeGit(root: string): (root: string, args: readonly string[]) => GitRunResult {
  return (_root, args) => {
    if (args[0] === "rev-parse" && args.includes("HEAD")) {
      return { code: 0, stdout: "deadbeef", stderr: "" };
    }
    if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
      return { code: 0, stdout: root, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "" };
  };
}

function userMd(): ResolveUserMdResult {
  return {
    path: "/home/x/.config/deft/USER.md",
    rung: "platform-config",
    found: true,
    diagnostic: "USER.md resolved",
    searched: [],
  };
}

function baseOptions(root: string): SessionStartOptions {
  return {
    writeHistory: false,
    runGit: fakeGit(root),
    verifyTools: () => ({ exitCode: 0 }),
    runTriageWelcome: () => ({ exitCode: 0 }),
    resolveUserMd: () => userMd(),
    probeEnvironment: () => environment,
    ceremonyDial: STANDARD_DIAL,
    emitRunSummary: false,
    probeScm: () => ({
      ready: true,
      binary: "gh",
      binaryPath: "/usr/bin/gh",
      authState: "authenticated",
      githubAuthMode: "host-gh",
      runtimeMode: "local-unsandboxed",
      injectedTokenPresent: false,
      depth: "shallow",
      detail: "SCM ready",
      remediation: null,
      skippedGates: [],
      login: null,
      failureKind: null,
    }),
  };
}

function fakeOrientation(compact = false): OrientationBundle {
  return {
    depositSha: "abc123def456",
    compact,
    orientationCallCount: 4,
    later: {
      status: ORIENTATION_LATER_STATUS,
      command: "deft orient",
      trigger: "telemetry threshold",
    },
    preflight: {
      status: "ok",
      ok: true,
      degraded: false,
      findings: [],
      lines: ["[deft preflight] toolchain status: ok"],
      skipGateIds: [],
    },
    lines: compact
      ? ["doctor=ok", "preflight=ok", "agents_refresh=sha_match", "cache_fresh=ok"]
      : [
          "[deft orientation] doctor: ok",
          "[deft doctor] status: ok",
          "[deft orientation] preflight: ok",
          "[deft preflight] toolchain status: ok",
          "[deft orientation] agents_refresh: sha_match",
          "agents:refresh: unchanged - sha match",
          "[deft orientation] cache_fresh: ok",
          "✓ cache fresh",
        ],
    sections: [
      {
        name: "doctor",
        status: "ok",
        ok: true,
        exitCode: 0,
        lines: ["[deft doctor] status: ok"],
        shaMatch: false,
        durationMs: 1,
      },
      {
        name: "preflight",
        status: "ok",
        ok: true,
        exitCode: 0,
        lines: ["[deft preflight] toolchain status: ok"],
        shaMatch: false,
        durationMs: 1,
      },
      {
        name: "agents_refresh",
        status: "sha_match",
        ok: true,
        exitCode: 0,
        lines: ["agents:refresh: unchanged - sha match"],
        shaMatch: true,
        durationMs: 1,
      },
      {
        name: "cache_fresh",
        status: "ok",
        ok: true,
        exitCode: 0,
        lines: ["✓ cache fresh"],
        shaMatch: false,
        durationMs: 1,
      },
    ],
    state: {
      schema_version: 1,
      deposit_sha: "abc123def456",
      updated_at: "2026-08-11T00:00:00Z",
    },
  };
}

describe("session:start orientation compression (#3286)", () => {
  it("mutation session:start output includes doctor + preflight sections", () => {
    const root = tempRoot();
    const result = runSessionStart(root, {
      ...baseOptions(root),
      orientation: fakeOrientation(false),
    });
    expect(result.code).toBe(0);
    const text = result.lines.join("\n");
    expect(text).toContain("doctor");
    expect(text).toContain("preflight");
    expect(result.payload.orientation).toMatchObject({
      deposit_sha: "abc123def456",
      call_count: 4,
      later: { status: ORIENTATION_LATER_STATUS },
    });
    const gated = result.payload.gated_steps as Record<string, { ok?: boolean }>;
    expect(gated.doctor?.ok).toBe(true);
    expect(gated.cache_fresh?.ok).toBe(true);
  });

  it("compact orientation uses terse machine format", () => {
    const root = tempRoot();
    const result = runSessionStart(root, {
      ...baseOptions(root),
      compact: true,
      orientation: fakeOrientation(true),
    });
    expect(result.lines).toContain("doctor=ok");
    expect(result.lines).toContain("preflight=ok");
    expect(result.payload.orientation).toMatchObject({ compact: true });
  });

  it("read-only posture does not run orientation composition (#2176)", () => {
    const root = tempRoot();
    let orientationUsed = false;
    const result = runSessionStart(root, {
      ...baseOptions(root),
      posture: READ_ONLY_POSTURE,
      orientation: {
        ...fakeOrientation(false),
        get lines() {
          orientationUsed = true;
          return fakeOrientation(false).lines;
        },
      },
    });
    expect(result.code).toBe(0);
    expect(result.payload.posture).toBe(READ_ONLY_POSTURE);
    expect(existsSync(ritualStatePath(root))).toBe(false);
    expect(orientationUsed).toBe(false);
    expect(result.payload.orientation).toBeUndefined();
    expect(result.lines.join("\n")).not.toContain("[deft orientation]");
    expect(result.lines.join("\n")).not.toContain("doctor=ok");
  });

  it("dual-path Later remains open on Now completion payload", () => {
    const root = tempRoot();
    const result = runSessionStart(root, {
      ...baseOptions(root),
      orientation: fakeOrientation(false),
    });
    const orientation = result.payload.orientation as {
      later: { status: string; command: string };
    };
    expect(orientation.later.status).toBe("open");
    expect(orientation.later.command).toBe("deft orient");
  });
});
