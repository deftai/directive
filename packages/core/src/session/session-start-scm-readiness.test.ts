import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EnvironmentContext } from "../platform/shell-context.js";
import type { ScmReadinessReport } from "../scm/readiness.js";
import type { ResolveUserMdResult } from "../user-config/resolve-user-md.js";
import { ritualStatePath } from "./ritual-sentinel.js";
import { READ_ONLY_POSTURE, runSessionStart } from "./session-start.js";

const temps: string[] = [];
const environment: EnvironmentContext = {
  hostPlatform: "linux",
  shell: { name: "bash", path: "/bin/bash", kind: "default", source: "SHELL" },
};

afterEach(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  temps.length = 0;
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "session-scm-"));
  temps.push(root);
  return root;
}

function userMd(): ResolveUserMdResult {
  return {
    path: "/home/x/.config/deft/USER.md",
    rung: "platform-config",
    found: true,
    diagnostic: "USER.md resolved from platform config dir",
    searched: [],
  };
}

function scmReady(): ScmReadinessReport {
  return {
    ready: true,
    binary: "ghx",
    binaryPath: "/usr/bin/ghx",
    authState: "authenticated",
    githubAuthMode: "host-gh",
    runtimeMode: "local-unsandboxed",
    injectedTokenPresent: false,
    depth: "shallow",
    detail: "SCM ready: ghx present, host-gh authenticated (shallow)",
    remediation: null,
    skippedGates: [],
    login: null,
    failureKind: null,
  };
}

function scmMissing(): ScmReadinessReport {
  return {
    ready: false,
    binary: null,
    binaryPath: null,
    authState: "binary-absent",
    githubAuthMode: "injected-token",
    runtimeMode: "cloud-headless",
    injectedTokenPresent: false,
    depth: "shallow",
    detail: "gh not found on PATH in this execution env; SCM-dependent gates skipped",
    remediation: "install gh",
    skippedGates: ["triage:queue", "issue:ingest", "pr:*", "scm:*"],
    login: null,
    failureKind: "binary_absent",
  };
}

const gitOk = (root: string) => (_r: string, args: readonly string[]) => {
  if (args[0] === "rev-parse" && args.includes("HEAD")) {
    return { code: 0, stdout: "abc123", stderr: "" };
  }
  if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
    return { code: 0, stdout: root, stderr: "" };
  }
  return { code: 1, stdout: "", stderr: "" };
};

describe("session:start SCM readiness reporting (#2275)", () => {
  it("read-only posture includes scm lines and payload without writing ritual-state", () => {
    const root = tempRoot();
    const result = runSessionStart(root, {
      posture: READ_ONLY_POSTURE,
      resolveUserMd: () => userMd(),
      probeEnvironment: () => environment,
      probeScm: () => scmMissing(),
    });
    expect(result.code).toBe(0);
    expect(existsSync(ritualStatePath(root))).toBe(false);
    expect(result.lines.join("\n")).toContain("[deft scm]");
    expect(result.lines.join("\n")).toContain("skipped gates:");
    expect(result.payload.scm).toMatchObject({
      ready: false,
      auth_state: "binary-absent",
    });
  });

  it("mutation cold path records scm in payload and does not fail when SCM is absent", () => {
    const root = tempRoot();
    const result = runSessionStart(root, {
      writeHistory: false,
      resolveUserMd: () => userMd(),
      verifyTools: () => ({ exitCode: 0 }),
      runTriageWelcome: () => ({ exitCode: 0 }),
      probeEnvironment: () => environment,
      probeScm: () => scmMissing(),
      runGit: gitOk(root),
    });
    expect(result.code).toBe(0);
    expect(existsSync(ritualStatePath(root))).toBe(true);
    expect(result.lines.join("\n")).toContain("[deft scm]");
    expect(result.lines.join("\n")).toContain("SCM-dependent gates skipped");
    const scm = result.payload.scm as Record<string, unknown>;
    expect(scm.ready).toBe(false);
    expect(scm.skipped_gates).toEqual(
      expect.arrayContaining(["triage:queue", "issue:ingest", "pr:*"]),
    );
    const steps = result.payload.steps as Array<{ name: string }>;
    expect(steps.some((s) => s.name === "scm_readiness")).toBe(true);
  });

  it("mutation cold path reports ready SCM without skipped gates", () => {
    const root = tempRoot();
    const result = runSessionStart(root, {
      writeHistory: false,
      resolveUserMd: () => userMd(),
      verifyTools: () => ({ exitCode: 0 }),
      runTriageWelcome: () => ({ exitCode: 0 }),
      probeEnvironment: () => environment,
      probeScm: () => scmReady(),
      runGit: gitOk(root),
    });
    expect(result.code).toBe(0);
    expect(result.lines.join("\n")).toContain("SCM ready");
    expect(result.lines.join("\n")).not.toContain("skipped gates:");
    expect(result.payload.scm).toMatchObject({ ready: true, binary: "ghx" });
  });

  it("uses deep probe when optional network is enabled", () => {
    const root = tempRoot();
    let seenDepth: string | undefined;
    runSessionStart(root, {
      writeHistory: false,
      resolveUserMd: () => userMd(),
      verifyTools: () => ({ exitCode: 0 }),
      runTriageWelcome: () => ({ exitCode: 0 }),
      probeEnvironment: () => environment,
      allowOptionalNetwork: true,
      probeReleaseAvailability: () => ({ lines: [] }),
      probeScm: (opts) => {
        seenDepth = opts.depth;
        return scmReady();
      },
      runGit: gitOk(root),
    });
    expect(seenDepth).toBe("deep");
  });
});
