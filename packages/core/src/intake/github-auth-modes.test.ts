import { describe, expect, it } from "vitest";
import type { CompletedProcess } from "../scm/call.js";
import {
  deriveValidationRepo,
  ENV_EXPECTED_GITHUB_LOGIN,
  type ExpectedGithubWorkerPrincipal,
  FAILURE_API_UNREACHABLE,
  FAILURE_GH_AUTH,
  FAILURE_INSTALLATION_IDENTITY_UNVERIFIABLE,
  FAILURE_INVALID_MODE,
  FAILURE_MISSING_INJECTED_TOKEN,
  FAILURE_MISSING_TARGET_REPO,
  FAILURE_PRINCIPAL_MISMATCH,
  FAILURE_REPO_ACCESS,
  findInjectedToken,
  formatUserApiFailureDetail,
  type GhRunner,
  githubAuthModesMain,
  INSTALLATION_IDENTITY_ISSUE_URL,
  inferGithubAuthMode,
  isInstallationUserEndpointInapplicable,
  PRINCIPAL_KIND_USER,
  parseOwnerRepoSlug,
  resultToDict,
  validateGithubAuth,
  validateGithubAuthForWorker,
  validateHostGhMode,
  validateInjectedTokenMode,
} from "./github-auth-modes.js";
import { mainEntry as githubAuthModesCliMain } from "./github-auth-modes-cli.js";
import {
  RUNTIME_MODE_CLOUD_HEADLESS,
  RUNTIME_MODE_CURSOR_NATIVE_SANDBOX,
} from "./platform-capabilities.js";

function proc(
  returncode: number,
  stdout = "",
  stderr = "",
  args: readonly string[] = [],
): CompletedProcess {
  return { returncode, stdout, stderr, args: [...args] };
}

function stubGh(options: {
  authCode?: number;
  user?: { code: number; stdout?: string; stderr?: string };
  repoCode?: number;
}): GhRunner {
  return (args) => {
    if (args[0] === "auth") {
      return proc(options.authCode ?? 0, "ok", "", args);
    }
    if (args[0] === "api" && args[1] === "user") {
      const user = options.user ?? { code: 0, stdout: '{"login":"octo"}' };
      return proc(user.code, user.stdout ?? "", user.stderr ?? "", args);
    }
    if (args[0] === "api" && String(args[1]).endsWith("/installation")) {
      return proc(1, "", `unexpected JWT App probe: ${args.join(" ")}`, args);
    }
    if (args[0] === "api" && String(args[1]).startsWith("repos/")) {
      const code = options.repoCode ?? 0;
      return proc(code, code === 0 ? "{}" : "", code === 0 ? "" : "denied", args);
    }
    return proc(1, "", `unexpected: ${args.join(" ")}`, args);
  };
}

const TARGET_REPO = "acme/widgets";
const USER_PRINCIPAL: ExpectedGithubWorkerPrincipal = { kind: PRINCIPAL_KIND_USER, login: "octo" };

const INSTALLATION_USER_403 = {
  code: 1,
  stdout: '{"message":"Resource not accessible by integration","status":"403"}',
  stderr: "gh: Resource not accessible by integration (HTTP 403)",
};

describe("github-auth-modes", () => {
  it("finds injected token env vars", () => {
    expect(findInjectedToken({ GH_TOKEN: "secret" })).toBe("secret");
    expect(findInjectedToken({})).toBeNull();
  });

  it("infers injected-token for cloud headless", () => {
    expect(inferGithubAuthMode({ runtimeMode: RUNTIME_MODE_CLOUD_HEADLESS })).toBe(
      "injected-token",
    );
  });

  it("rejects unknown auth mode", () => {
    const result = validateGithubAuth("bogus", { environ: {} });
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe(FAILURE_INVALID_MODE);
  });

  it("validates host-gh with stub runner", () => {
    const result = validateGithubAuth("host-gh", {
      environ: {},
      repo: TARGET_REPO,
      runGh: stubGh({}),
    });
    expect(result.ok).toBe(true);
    expect(result.login).toBe("octo");
    expect(result.validationRepo).toBe(TARGET_REPO);
  });

  it("defaultRunGh path fails closed when live gh is unavailable (#3027)", () => {
    const result = validateGithubAuth("host-gh", {
      environ: { PATH: "" },
      repo: TARGET_REPO,
      readGitRemote: () => null,
    });
    expect(result.ok).toBe(false);
    expect(result.detail.length).toBeGreaterThan(0);
  });

  it("validates injected-token mode when token present (#3027)", () => {
    const result = validateGithubAuth("injected-token", {
      environ: { GH_TOKEN: "ghs_test_not_real" },
      repo: TARGET_REPO,
      runGh: stubGh({ user: { code: 0, stdout: '{"login":"bot"}' } }),
    });
    expect(result.ok).toBe(true);
    expect(result.login).toBe("bot");
  });

  it("injected-token missing token fails closed (#3027)", () => {
    const result = validateInjectedTokenMode({});
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe(FAILURE_MISSING_INJECTED_TOKEN);
  });

  it("injected-token auth status failure includes sandbox remediation (#3027)", () => {
    const result = validateInjectedTokenMode(
      { GH_TOKEN: "t" },
      {
        runtimeMode: RUNTIME_MODE_CURSOR_NATIVE_SANDBOX,
        repo: TARGET_REPO,
        runGh: stubGh({ authCode: 1 }),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe(FAILURE_GH_AUTH);
    expect(result.remediation).toMatch(/sandbox/i);
  });

  it("injected-token API unreachable and repo-access branches (#3027)", () => {
    const unreachable = validateInjectedTokenMode(
      { GITHUB_TOKEN: "t" },
      {
        repo: TARGET_REPO,
        runGh: stubGh({
          user: { code: 1, stdout: "", stderr: "timeout" },
        }),
      },
    );
    expect(unreachable.failureKind).toBe(FAILURE_API_UNREACHABLE);
    expect(unreachable.detail).toMatch(/unreachable/i);

    const noRepo = validateInjectedTokenMode(
      { GH_ENTERPRISE_TOKEN: "t" },
      {
        repo: TARGET_REPO,
        expectedPrincipal: { kind: PRINCIPAL_KIND_USER, login: "u" },
        runGh: stubGh({
          user: { code: 0, stdout: '{"login":"u"}' },
          repoCode: 1,
        }),
      },
    );
    expect(noRepo.failureKind).toBe(FAILURE_REPO_ACCESS);
    expect(noRepo.login).toBe("u");
    expect(noRepo.remediation).toMatch(/repo-access|repository/i);
  });

  it("host-gh mode auth failure and bare-string login parse (#3027)", () => {
    const badAuth = validateHostGhMode(
      {},
      {
        runGh: () => proc(1, "", "auth"),
      },
    );
    expect(badAuth.ok).toBe(false);
    expect(badAuth.failureKind).toBe(FAILURE_GH_AUTH);

    const ok = validateHostGhMode(
      {},
      {
        repo: TARGET_REPO,
        runGh: stubGh({ user: { code: 0, stdout: '"octocat"' } }),
      },
    );
    expect(ok.ok).toBe(true);
    expect(ok.login).toBe("octocat");
  });

  it("host-gh invalid repo slug fails closed (#3665)", () => {
    const result = validateHostGhMode(
      {},
      {
        repo: "not-a-slug",
        runGh: stubGh({}),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe(FAILURE_MISSING_TARGET_REPO);
    expect(result.detail).toMatch(/invalid repository slug/);
  });

  it("host-gh API unreachable and repo-access failure branches (#3027)", () => {
    const unreachable = validateHostGhMode(
      {},
      {
        repo: TARGET_REPO,
        runGh: stubGh({
          user: { code: 1, stdout: "", stderr: "timeout" },
        }),
      },
    );
    expect(unreachable.failureKind).toBe(FAILURE_API_UNREACHABLE);
    expect(unreachable.detail).toMatch(/\/user failed/);
    expect(unreachable.detail).toMatch(/unreachable/i);

    const noRepo = validateHostGhMode(
      {},
      {
        repo: TARGET_REPO,
        runtimeMode: RUNTIME_MODE_CURSOR_NATIVE_SANDBOX,
        runGh: stubGh({
          user: { code: 0, stdout: '{"login":"u"}' },
          repoCode: 1,
        }),
      },
    );
    expect(noRepo.failureKind).toBe(FAILURE_REPO_ACCESS);
    expect(noRepo.login).toBe("u");
    expect(noRepo.remediation).toMatch(/sandbox/i);
    expect(noRepo.remediation).toMatch(/repo-access|repository/i);
  });

  it("parseLogin empty and non-login object paths fail closed (#3665)", () => {
    const emptyLogin = validateHostGhMode(
      {},
      {
        repo: TARGET_REPO,
        runGh: stubGh({ user: { code: 0, stdout: "   " } }),
      },
    );
    expect(emptyLogin.ok).toBe(false);
    expect(emptyLogin.failureKind).toBe(FAILURE_PRINCIPAL_MISMATCH);
    expect(emptyLogin.login).toBeNull();

    const noLoginField = validateHostGhMode(
      {},
      {
        repo: TARGET_REPO,
        runGh: stubGh({ user: { code: 0, stdout: '{"id":1}' } }),
      },
    );
    expect(noLoginField.ok).toBe(false);
    expect(noLoginField.failureKind).toBe(FAILURE_PRINCIPAL_MISMATCH);

    const bareText = validateHostGhMode(
      {},
      {
        repo: TARGET_REPO,
        runGh: stubGh({ user: { code: 0, stdout: "not-json-login" } }),
      },
    );
    expect(bareText.ok).toBe(true);
    expect(bareText.login).toBe("not-json-login");
  });

  it("validateGithubAuthForWorker infers mode and resultToDict/cli emit (#3027)", () => {
    const worker = validateGithubAuthForWorker("host-gh", {
      repo: TARGET_REPO,
      runGh: () => proc(1, "", "auth"),
    });
    expect(worker.ok).toBe(false);
    expect(worker.failureKind).toBe(FAILURE_GH_AUTH);

    const dict = resultToDict(worker);
    expect(dict.ok).toBe(false);
    expect(dict.github_auth_mode).toBe("host-gh");
    expect(dict.failure_kind).toBe(FAILURE_GH_AUTH);

    const missing = validateGithubAuth("injected-token", {
      environ: {},
      runGh: stubGh({}),
    });
    expect(missing.ok).toBe(false);
    expect(missing.failureKind).toBe(FAILURE_MISSING_INJECTED_TOKEN);

    const exitHost = githubAuthModesMain({
      githubAuthMode: "host-gh",
      repo: TARGET_REPO,
      json: false,
      runGh: stubGh({ user: { code: 0, stdout: '{"login":"h"}' } }),
    });
    expect(exitHost).toBe(0);

    const exitJson = githubAuthModesMain({
      githubAuthMode: "host-gh",
      repo: TARGET_REPO,
      json: true,
      runGh: () => proc(1, "", "auth"),
    });
    expect(exitJson).toBe(1);
  });

  it("infers injected mode for cloud headless and prints remediation on CLI fail (#3027)", () => {
    expect(
      inferGithubAuthMode({
        runtimeMode: RUNTIME_MODE_CLOUD_HEADLESS,
      } as never),
    ).toBe("injected-token");

    const failRemediation = validateHostGhMode(
      {},
      {
        runtimeMode: RUNTIME_MODE_CURSOR_NATIVE_SANDBOX,
        runGh: () => proc(1, "", "auth"),
      },
    );
    expect(failRemediation.remediation).toMatch(/sandbox/i);

    const code = githubAuthModesMain({
      githubAuthMode: "host-gh",
      repo: TARGET_REPO,
      json: false,
      runGh: () => proc(1, "", "nope"),
    });
    expect(code).toBe(1);

    const inferred = validateGithubAuthForWorker(null, {
      runtimeReport: {
        runtimeMode: RUNTIME_MODE_CLOUD_HEADLESS,
      } as never,
      runGh: () => proc(1, "", "x"),
    });
    expect(inferred.githubAuthMode).toBe("injected-token");
  });
});

describe("expected GitHub worker principal (#3665)", () => {
  it("parses owner/repo from slugs and remotes", () => {
    expect(parseOwnerRepoSlug("acme/widgets")).toBe("acme/widgets");
    expect(parseOwnerRepoSlug("https://github.com/acme/widgets.git")).toBe("acme/widgets");
    expect(parseOwnerRepoSlug("git@github.com:acme/widgets.git")).toBe("acme/widgets");
    expect(parseOwnerRepoSlug("git@github.example.com:acme/widgets.git")).toBe("acme/widgets");
    expect(parseOwnerRepoSlug("not-a-slug")).toBeNull();
  });

  it("derives the target repo from GH_REPO rather than a public default", () => {
    const derived = deriveValidationRepo({
      environ: { GH_REPO: "acme/widgets" },
      readGitRemote: () => "https://github.com/deftai/directive.git",
    });
    expect(derived).toEqual({ ok: true, repo: "acme/widgets" });
  });

  it("fails closed when no target repo can be derived", () => {
    const isolated = validateHostGhMode(
      {},
      {
        runGh: stubGh({}),
        readGitRemote: () => null,
      },
    );
    expect(isolated.ok).toBe(false);
    expect(isolated.failureKind).toBe(FAILURE_MISSING_TARGET_REPO);
    expect(isolated.detail).not.toMatch(/deftai\/directive/);
  });

  it("compares /user login against an expected user principal", () => {
    const match = validateHostGhMode(
      {},
      {
        repo: TARGET_REPO,
        expectedPrincipal: USER_PRINCIPAL,
        runGh: stubGh({}),
      },
    );
    expect(match.ok).toBe(true);
    expect(match.login).toBe("octo");
    expect(match.principal).toEqual({ kind: PRINCIPAL_KIND_USER, login: "octo" });

    const mismatch = validateHostGhMode(
      {},
      {
        repo: TARGET_REPO,
        expectedPrincipal: { kind: PRINCIPAL_KIND_USER, login: "maintainer" },
        runGh: stubGh({}),
      },
    );
    expect(mismatch.ok).toBe(false);
    expect(mismatch.failureKind).toBe(FAILURE_PRINCIPAL_MISMATCH);
    expect(mismatch.login).toBe("octo");
    expect(mismatch.detail).toMatch(/identity mismatch/);
  });

  it("fails closed on an installation credential even with an expected user login", () => {
    const result = validateInjectedTokenMode(
      { GH_TOKEN: "present-not-captured" },
      {
        repo: TARGET_REPO,
        expectedPrincipal: USER_PRINCIPAL,
        runGh: stubGh({ user: INSTALLATION_USER_403 }),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe(FAILURE_INSTALLATION_IDENTITY_UNVERIFIABLE);
    expect(result.detail).toMatch(/inapplicable/i);
    expect(result.detail).toContain(INSTALLATION_IDENTITY_ISSUE_URL);
    expect(result.detail).not.toMatch(/unreachable/i);
    expect(JSON.stringify(result)).not.toContain("present-not-captured");
  });

  it("fails closed on an installation credential with no expected principal", () => {
    const result = validateInjectedTokenMode(
      { GH_TOKEN: "present-not-captured" },
      {
        repo: TARGET_REPO,
        runGh: stubGh({ user: INSTALLATION_USER_403 }),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe(FAILURE_INSTALLATION_IDENTITY_UNVERIFIABLE);
    expect(result.detail).toMatch(/cannot disclose which App/i);
    expect(JSON.stringify(resultToDict(result))).not.toContain("present-not-captured");
  });

  it("does not treat an installation-token /user 403 as API unreachability", () => {
    const proc403 = proc(
      1,
      '{"message":"Resource not accessible by integration","status":"403"}',
      "gh: Resource not accessible by integration (HTTP 403)",
    );
    expect(isInstallationUserEndpointInapplicable(proc403)).toBe(true);
    const detail = formatUserApiFailureDetail("host-gh", proc403);
    expect(detail).not.toMatch(/API is unreachable/);

    const result = validateHostGhMode(
      {},
      {
        repo: TARGET_REPO,
        runGh: stubGh({ user: INSTALLATION_USER_403 }),
      },
    );
    expect(result.failureKind).toBe(FAILURE_INSTALLATION_IDENTITY_UNVERIFIABLE);
    expect(result.detail).not.toMatch(/API is unreachable/);
    expect(result.ok).toBe(false);
  });

  it("still reports a true unreachable detail when /user cannot be reached", () => {
    const result = validateHostGhMode(
      {},
      {
        repo: TARGET_REPO,
        runGh: stubGh({ user: { code: 1, stdout: "", stderr: "dial tcp: i/o timeout" } }),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe(FAILURE_API_UNREACHABLE);
    expect(result.detail).toMatch(/unreachable/i);
  });

  it("resolves expected user principal from env", () => {
    const result = validateHostGhMode(
      { [ENV_EXPECTED_GITHUB_LOGIN]: "octo" },
      {
        repo: TARGET_REPO,
        runGh: stubGh({}),
      },
    );
    expect(result.ok).toBe(true);
    expect(result.principal).toEqual({ kind: PRINCIPAL_KIND_USER, login: "octo" });
  });

  it("does not accept an installation credential from an App-slug env assertion", () => {
    const result = validateHostGhMode(
      { DEFT_EXPECTED_GITHUB_APP_SLUG: "deft-worker" },
      {
        repo: TARGET_REPO,
        runGh: stubGh({ user: INSTALLATION_USER_403 }),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe(FAILURE_INSTALLATION_IDENTITY_UNVERIFIABLE);
  });

  it("CLI expected-login mismatch fails closed", () => {
    const code = githubAuthModesMain({
      githubAuthMode: "host-gh",
      repo: TARGET_REPO,
      expectedLogin: "maintainer",
      json: true,
      runGh: stubGh({}),
    });
    expect(code).toBe(1);
  });

  it("CLI App-installation flags are deferred to #3693", () => {
    expect(githubAuthModesCliMain(["--expected-app-slug", "deft-worker"])).toBe(2);
  });
});
