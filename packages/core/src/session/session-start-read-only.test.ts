import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EnvironmentContext } from "../platform/shell-context.js";
import type { ResolveUserMdResult } from "../user-config/resolve-user-md.js";
import { ritualStatePath } from "./ritual-sentinel.js";
import { READ_ONLY_POSTURE, READ_ONLY_RESULT_MESSAGE, runSessionStart } from "./session-start.js";

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
      "branch_policy",
      "verify_tools",
      "triage_welcome",
      "release_probe",
      "ritual_write",
    ]);
    expect(steps.find((s) => s.name === "release_probe")?.skipped).toBe(true);
    expect(typeof result.payload.duration_ms).toBe("number");
  });
});
