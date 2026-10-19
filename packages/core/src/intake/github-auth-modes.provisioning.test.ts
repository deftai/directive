import { describe, expect, it } from "vitest";
import type { CompletedProcess } from "../scm/call.js";
import {
  FAILURE_API_UNREACHABLE,
  FAILURE_INSTALLATION_IDENTITY_UNVERIFIABLE,
  FAILURE_PRINCIPAL_MISMATCH,
  findApplicableInjectedToken,
  type GhRunner,
  githubApiPath,
  inferGithubAuthMode,
  isWellFormedInstallationRepositories,
  parseGithubHostFromRemote,
  resolveGithubHost,
  validateGithubAuth,
  validateHostGhMode,
  validateInjectedTokenMode,
} from "./github-auth-modes.js";

function proc(
  returncode: number,
  stdout = "",
  stderr = "",
  args: readonly string[] = [],
): CompletedProcess {
  return { returncode, stdout, stderr, args: [...args] };
}

const TARGET = "acme/widgets";
const INSTALLATION_OK = '{"total_count":1,"repositories":[{"full_name":"acme/widgets"}]}';
const USER_403 = {
  code: 1,
  stdout: '{"message":"Resource not accessible by integration","status":"403"}',
  stderr: "gh: Resource not accessible by integration (HTTP 403)",
};

function stub(options: {
  user?: { code: number; stdout?: string; stderr?: string };
  repoCode?: number;
  installation?: { code: number; stdout?: string; stderr?: string };
  seen?: string[][];
}): GhRunner {
  return (args) => {
    options.seen?.push([...args]);
    const apiPath = githubApiPath(args);
    if (apiPath === "user") {
      const user = options.user ?? { code: 0, stdout: '{"login":"octo"}' };
      return proc(user.code, user.stdout ?? "", user.stderr ?? "", args);
    }
    if (apiPath === "installation/repositories") {
      const installation = options.installation ?? { code: 1, stdout: "", stderr: "denied" };
      return proc(installation.code, installation.stdout ?? "", installation.stderr ?? "", args);
    }
    if (apiPath?.startsWith("repos/")) {
      const code = options.repoCode ?? 0;
      return proc(code, code === 0 ? "{}" : "", code === 0 ? "" : "denied", args);
    }
    return proc(1, "", `unexpected: ${args.join(" ")}`, args);
  };
}

/** Exact --hostname/-H next-token equality on an API row (CodeQL #137 / #5746). */
function hostnameBoundOnApiRow(row: readonly string[], expectedHost: string): boolean {
  if (githubApiPath(row) === null) {
    return false;
  }
  for (let i = 0; i < row.length; i += 1) {
    const token = row[i];
    if (token === "--hostname" || token === "-H") {
      return row[i + 1] === expectedHost;
    }
  }
  return false;
}

describe("provisioning-trust host and source (#5016)", () => {
  it("resolves GH_HOST over git remote", () => {
    expect(
      resolveGithubHost({
        environ: { GH_HOST: "ghe.example.com" },
        gitRemoteUrl: "https://github.com/acme/widgets.git",
      }),
    ).toBe("ghe.example.com");
    expect(parseGithubHostFromRemote("git@octo.ghe.com:acme/widgets.git")).toBe("octo.ghe.com");
  });

  it("skips origin lookup when gitRemoteUrl is null", () => {
    expect(
      resolveGithubHost({
        environ: {},
        gitRemoteUrl: null,
        readGitRemote: () => {
          throw new Error("origin must not be read");
        },
      }),
    ).toBe("github.com");
  });

  it("uses origin when GH_HOST is absent", () => {
    expect(
      resolveGithubHost({
        environ: {},
        gitRemoteUrl: "https://ghe.internal/acme/widgets.git",
      }),
    ).toBe("ghe.internal");
  });

  it("keeps a non-default GHES port from the remote URL", () => {
    expect(parseGithubHostFromRemote("https://ghe.internal:8443/acme/widgets.git")).toBe(
      "ghe.internal:8443",
    );
    expect(
      resolveGithubHost({
        environ: {},
        gitRemoteUrl: "https://ghe.internal:8443/acme/widgets.git",
      }),
    ).toBe("ghe.internal:8443");
  });

  it("applies host-family tokens and ignores the other family", () => {
    expect(findApplicableInjectedToken({ GH_TOKEN: "t" }, "github.com")?.name).toBe("GH_TOKEN");
    expect(findApplicableInjectedToken({ GH_ENTERPRISE_TOKEN: "t" }, "github.com")).toBeNull();
    expect(
      findApplicableInjectedToken({ GITHUB_ENTERPRISE_TOKEN: "t" }, "ghe.internal")?.name,
    ).toBe("GITHUB_ENTERPRISE_TOKEN");
    expect(findApplicableInjectedToken({ GH_TOKEN: "t" }, "ghe.internal")).toBeNull();
  });

  it("infers the same mode for local/CI/cloud given the same credentials", () => {
    expect(inferGithubAuthMode({})).toBe("host-gh");
    expect(inferGithubAuthMode({ CI: "true", GITHUB_ACTIONS: "true" })).toBe("host-gh");
    expect(inferGithubAuthMode({ CURSOR_AGENT: "1", CURSOR_AGENT_SOCKET: "/tmp/s" })).toBe(
      "host-gh",
    );
    expect(inferGithubAuthMode({ GH_TOKEN: "t", CI: "true" })).toBe("injected-token");
    expect(inferGithubAuthMode({ GH_TOKEN: "t" })).toBe("injected-token");
  });

  it("does not fall back to the store when an applicable token is invalid", () => {
    const result = validateInjectedTokenMode(
      { GH_TOKEN: "bad" },
      {
        repo: TARGET,
        runGh: stub({ user: { code: 1, stdout: '{"message":"Bad credentials","status":"401"}' } }),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe(FAILURE_API_UNREACHABLE);
    expect(result.credentialSource).toBe("injected-token");
    expect(result.applicableTokenEnv).toBe("GH_TOKEN");
  });

  it("does not treat an unrelated-host token as this operation's injected source", () => {
    const result = validateHostGhMode(
      { GH_ENTERPRISE_TOKEN: "other-host" },
      { repo: TARGET, runGh: stub({}) },
    );
    expect(result.ok).toBe(true);
    expect(result.credentialSource).toBe("host-store");
    expect(result.applicableTokenEnv).toBeNull();
    expect(JSON.stringify(result)).not.toContain("other-host");
  });

  it("does not veto a working target credential when aggregate auth status would fail", () => {
    const seen: string[][] = [];
    const result = validateHostGhMode(
      {},
      {
        repo: TARGET,
        runGh: (args) => {
          seen.push([...args]);
          if (args[0] === "auth") return proc(1, "", "inactive account on other host", args);
          return stub({ seen })(args);
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(seen.some((row) => row[0] === "auth")).toBe(false);
  });

  it("uses --hostname for GHES API probes", () => {
    const seen: string[][] = [];
    const expectedHost = "ghe.example.com";
    const result = validateHostGhMode(
      { GH_HOST: expectedHost },
      { repo: TARGET, runGh: stub({ seen }) },
    );
    expect(result.ok).toBe(true);
    expect(result.githubHost).toBe(expectedHost);
    expect(seen.some((row) => hostnameBoundOnApiRow(row, expectedHost))).toBe(true);
    // Lookalike host tokens must not satisfy exact next-token binding (CodeQL #137).
    expect(
      hostnameBoundOnApiRow(["api", "--hostname", "ghe.example.com.evil", "user"], expectedHost),
    ).toBe(false);
    expect(
      hostnameBoundOnApiRow(["api", "--hostname", "not-ghe.example.com", "user"], expectedHost),
    ).toBe(false);
  });
});

describe("installation authentication without App identity (#5016 / #3693)", () => {
  it("requires a well-formed authenticated installation probe", () => {
    expect(isWellFormedInstallationRepositories(INSTALLATION_OK)).toBe(true);
    expect(isWellFormedInstallationRepositories("not-json")).toBe(false);
    expect(isWellFormedInstallationRepositories('{"html":true}')).toBe(false);
  });

  it("rejects an unauthenticated installation probe", () => {
    const result = validateHostGhMode(
      {},
      {
        repo: TARGET,
        runGh: stub({
          user: USER_403,
          installation: {
            code: 1,
            stdout: '{"message":"Requires authentication","status":"401"}',
            stderr: "HTTP 401",
          },
        }),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.installationAuthenticated).toBe(false);
    expect(result.failureKind).toBe(FAILURE_API_UNREACHABLE);
  });

  it("cannot satisfy a required user", () => {
    const result = validateGithubAuth("host-gh", {
      environ: {},
      repo: TARGET,
      expectedPrincipal: { kind: "user", login: "octo" },
      runGh: stub({
        user: USER_403,
        installation: { code: 0, stdout: INSTALLATION_OK },
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe(FAILURE_INSTALLATION_IDENTITY_UNVERIFIABLE);
  });

  it("records no verified login on installation success", () => {
    const result = validateHostGhMode(
      {},
      {
        repo: TARGET,
        runGh: stub({
          user: USER_403,
          installation: { code: 0, stdout: INSTALLATION_OK },
        }),
      },
    );
    expect(result.ok).toBe(true);
    expect(result.login).toBeNull();
    expect(result.principal).toBeNull();
    expect(result.installationAuthenticated).toBe(true);
  });
});

describe("assigned-user compare remains case-insensitive (#5016)", () => {
  it("matches login case-insensitively", () => {
    const result = validateHostGhMode(
      {},
      {
        repo: TARGET,
        expectedPrincipal: { kind: "user", login: "Octo" },
        runGh: stub({ user: { code: 0, stdout: '{"login":"octo"}' } }),
      },
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a wrong user", () => {
    const result = validateHostGhMode(
      {},
      {
        repo: TARGET,
        expectedPrincipal: { kind: "user", login: "worker-a" },
        runGh: stub({}),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe(FAILURE_PRINCIPAL_MISMATCH);
  });
});
