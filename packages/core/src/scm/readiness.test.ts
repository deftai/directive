import { describe, expect, it } from "vitest";
import type { CompletedProcess } from "./call.js";
import { ScmStubError } from "./errors.js";
import {
  assertScmBinaryPresent,
  formatScmReadinessLines,
  probeScmReadiness,
  SCM_DEPENDENT_GATES,
  scmNotReadyError,
  scmReadinessToDict,
} from "./readiness.js";

function okProc(stdout = ""): CompletedProcess {
  return { args: [], returncode: 0, stdout, stderr: "" };
}
function failProc(stderr = "auth failed"): CompletedProcess {
  return { args: [], returncode: 1, stdout: "", stderr };
}

describe("probeScmReadiness (#2275)", () => {
  it("reports binary-absent when neither ghx nor gh is on PATH", () => {
    const report = probeScmReadiness({
      whichFn: () => null,
      env: {},
      checkAuthStatus: false,
      githubAuthMode: "host-gh",
      runtimeReport: { runtimeMode: "local-unsandboxed" },
    });
    expect(report.ready).toBe(false);
    expect(report.authState).toBe("binary-absent");
    expect(report.binary).toBeNull();
    expect(report.failureKind).toBe("binary_absent");
    expect(report.skippedGates).toEqual([...SCM_DEPENDENT_GATES]);
    expect(report.detail).toMatch(/gh not found on PATH/);
    expect(report.detail).toMatch(/SCM-dependent gates skipped/);
    expect(report.remediation).toMatch(/execution env/);
  });

  it("prefers ghx over gh in the binary ladder", () => {
    const report = probeScmReadiness({
      whichFn: (name) => (name === "ghx" || name === "gh" ? `/bin/${name}` : null),
      env: {},
      checkAuthStatus: false,
      githubAuthMode: "host-gh",
      runtimeReport: { runtimeMode: "local-unsandboxed" },
    });
    expect(report.ready).toBe(true);
    expect(report.binary).toBe("ghx");
    expect(report.binaryPath).toBe("/bin/ghx");
  });

  it("falls back to gh when ghx is absent", () => {
    const report = probeScmReadiness({
      whichFn: (name) => (name === "gh" ? "/usr/bin/gh" : null),
      env: {},
      checkAuthStatus: false,
      githubAuthMode: "host-gh",
      runtimeReport: { runtimeMode: "local-unsandboxed" },
    });
    expect(report.binary).toBe("gh");
    expect(report.ready).toBe(true);
  });

  it("injected-token mode without token is not ready (missing-token)", () => {
    const report = probeScmReadiness({
      whichFn: (name) => (name === "gh" ? "/usr/bin/gh" : null),
      env: {},
      checkAuthStatus: false,
      githubAuthMode: "injected-token",
      runtimeReport: { runtimeMode: "cloud-headless" },
    });
    expect(report.ready).toBe(false);
    expect(report.authState).toBe("missing-token");
    expect(report.failureKind).toBe("missing_injected_token");
    expect(report.detail).toMatch(/GH_TOKEN/);
    expect(report.skippedGates.length).toBeGreaterThan(0);
  });

  it("injected-token mode with GH_TOKEN present is ready when auth status skipped", () => {
    const report = probeScmReadiness({
      whichFn: (name) => (name === "gh" ? "/usr/bin/gh" : null),
      env: { GH_TOKEN: "ghs_test_not_a_real_token" },
      checkAuthStatus: false,
      githubAuthMode: "injected-token",
      runtimeReport: { runtimeMode: "cloud-headless" },
    });
    expect(report.ready).toBe(true);
    expect(report.injectedTokenPresent).toBe(true);
    // Never echo the token value.
    expect(JSON.stringify(scmReadinessToDict(report))).not.toContain("ghs_test");
  });

  it("shallow path marks unauthenticated when gh auth status fails", () => {
    const report = probeScmReadiness({
      whichFn: (name) => (name === "gh" ? "/usr/bin/gh" : null),
      env: {},
      depth: "shallow",
      githubAuthMode: "host-gh",
      runtimeReport: { runtimeMode: "local-unsandboxed" },
      runGh: () => failProc("not logged in"),
    });
    expect(report.ready).toBe(false);
    expect(report.authState).toBe("unauthenticated");
    expect(report.detail).toMatch(/gh not authenticated/);
    expect(report.skippedGates).toContain("triage:queue");
    expect(report.skippedGates).toContain("pr:*");
  });

  it("shallow path is ready when gh auth status succeeds", () => {
    const report = probeScmReadiness({
      whichFn: (name) => (name === "ghx" ? "/usr/bin/ghx" : null),
      env: {},
      depth: "shallow",
      githubAuthMode: "host-gh",
      runtimeReport: { runtimeMode: "local-unsandboxed" },
      runGh: () => okProc("Logged in"),
    });
    expect(report.ready).toBe(true);
    expect(report.authState).toBe("authenticated");
    expect(report.skippedGates).toEqual([]);
    expect(report.detail).toMatch(/SCM ready/);
  });

  it("deep path validates via github-auth-modes and surfaces login", () => {
    const report = probeScmReadiness({
      whichFn: (name) => (name === "gh" ? "/usr/bin/gh" : null),
      env: { GH_TOKEN: "tok" },
      depth: "deep",
      githubAuthMode: "injected-token",
      runtimeReport: { runtimeMode: "cloud-headless" },
      runGh: (args) => {
        if (args[0] === "auth") return okProc();
        if (args[0] === "api" && args[1] === "user") return okProc('"alice"');
        if (args[0] === "api" && String(args[1]).startsWith("repos/")) return okProc("{}");
        return failProc("unexpected");
      },
    });
    expect(report.ready).toBe(true);
    expect(report.login).toBe("alice");
    expect(report.depth).toBe("deep");
  });

  it("deep path not-ready when API unreachable", () => {
    const report = probeScmReadiness({
      whichFn: (name) => (name === "gh" ? "/usr/bin/gh" : null),
      env: { GH_TOKEN: "tok" },
      depth: "deep",
      githubAuthMode: "injected-token",
      runtimeReport: { runtimeMode: "cloud-headless" },
      runGh: (args) => {
        if (args[0] === "auth") return okProc();
        return failProc("network down");
      },
    });
    expect(report.ready).toBe(false);
    expect(report.failureKind).toBe("api_unreachable");
  });

  it("formatScmReadinessLines lists skipped gates when not ready", () => {
    const report = probeScmReadiness({
      whichFn: () => null,
      env: {},
      checkAuthStatus: false,
      githubAuthMode: "host-gh",
      runtimeReport: { runtimeMode: "cursor-native-sandbox" },
    });
    const lines = formatScmReadinessLines(report);
    expect(lines[0]).toMatch(/^\[deft scm\]/);
    expect(lines.some((l) => l.includes("skipped gates:"))).toBe(true);
    expect(lines.some((l) => l.includes("#2275"))).toBe(true);
  });

  it("formatScmReadinessLines is a single ready line when ready", () => {
    const report = probeScmReadiness({
      whichFn: (name) => (name === "gh" ? "/bin/gh" : null),
      env: {},
      checkAuthStatus: false,
      githubAuthMode: "host-gh",
      runtimeReport: { runtimeMode: "local-unsandboxed" },
    });
    const lines = formatScmReadinessLines(report);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/SCM ready|binary present/);
  });

  it("scmNotReadyError throws ScmStubError with #2275 remediation", () => {
    const report = probeScmReadiness({
      whichFn: () => null,
      env: {},
      checkAuthStatus: false,
      githubAuthMode: "host-gh",
      runtimeReport: { runtimeMode: "cloud-headless" },
    });
    const err = scmNotReadyError(report);
    expect(err).toBeInstanceOf(ScmStubError);
    expect(err.message).toMatch(/#2275/);
    expect(err.message).toMatch(/skipped_gates|execution env|GH_TOKEN/);
  });

  it("assertScmBinaryPresent returns binary or throws fail-loud", () => {
    expect(assertScmBinaryPresent((n) => (n === "gh" ? "/bin/gh" : null))).toBe("gh");
    expect(() => assertScmBinaryPresent(() => null)).toThrow(ScmStubError);
    expect(() => assertScmBinaryPresent(() => null)).toThrow(/#2275|execution env/);
  });

  it("requireScmReady throws when unauthenticated and caches when ready", async () => {
    const { requireScmReady, clearScmReadyCache } = await import("./readiness.js");
    clearScmReadyCache();
    expect(() =>
      requireScmReady({
        force: true,
        whichFn: () => null,
        env: {},
        githubAuthMode: "host-gh",
        runtimeReport: { runtimeMode: "local-unsandboxed" },
      }),
    ).toThrow(ScmStubError);

    clearScmReadyCache();
    const report = requireScmReady({
      force: true,
      whichFn: (n) => (n === "gh" ? "/bin/gh" : null),
      env: {},
      githubAuthMode: "host-gh",
      runtimeReport: { runtimeMode: "local-unsandboxed" },
      runGh: () => ({ args: [], returncode: 0, stdout: "ok", stderr: "" }),
    });
    expect(report.ready).toBe(true);
    // Cached path returns same ready report without re-running.
    const again = requireScmReady();
    expect(again.ready).toBe(true);
    clearScmReadyCache();
  });

  it("scmReadinessToDict uses snake_case and never includes secrets", () => {
    const report = probeScmReadiness({
      whichFn: (name) => (name === "gh" ? "/bin/gh" : null),
      env: { GITHUB_TOKEN: "super-secret-value-xyz" },
      checkAuthStatus: false,
      githubAuthMode: "injected-token",
      runtimeReport: { runtimeMode: "cloud-headless" },
    });
    const dict = scmReadinessToDict(report);
    expect(dict.auth_state).toBeDefined();
    expect(dict.github_auth_mode).toBe("injected-token");
    expect(dict.injected_token_present).toBe(true);
    expect(JSON.stringify(dict)).not.toContain("super-secret-value-xyz");
  });
});
