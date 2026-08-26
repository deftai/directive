import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ENV_EXPECTED_GITHUB_LOGIN,
  FAILURE_INSTALLATION_IDENTITY_UNVERIFIABLE,
  FAILURE_MISSING_INJECTED_TOKEN,
  FAILURE_PRINCIPAL_MISMATCH,
  type GhRunner,
} from "../intake/github-auth-modes.js";
import type { CompletedProcess } from "../scm/call.js";
import { applyWorktreeOccupancy, occupancyPath, readOccupancy } from "../session/occupancy.js";
import {
  buildManifest,
  formatDispatchAuthEnvelope,
  prepareWorkerCredentialInjection,
  type ResolvedStory,
  swarmLaunch,
} from "./launch.js";

const story: ResolvedStory = {
  token: "story-a",
  story_id: "story-a",
  path: "/abs/story-a.xbrief.json",
  relpath: "xbrief/active/story-a.xbrief.json",
};

const TARGET_REPO = "acme/widgets";
const WORKER_LOGIN = "deft-swarm-bot";
const FAKE_TOKEN = "gho_test_injection_token_1351";
const PREAMBLE_PATH = join(process.cwd(), "content/templates/agent-prompt-preamble.md");

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
      const user = options.user ?? { code: 0, stdout: `{"login":"${WORKER_LOGIN}"}` };
      return proc(user.code, user.stdout ?? "", user.stderr ?? "", args);
    }
    if (args[0] === "api" && String(args[1]).startsWith("repos/")) {
      const code = options.repoCode ?? 0;
      return proc(code, code === 0 ? "{}" : "", code === 0 ? "" : "denied", args);
    }
    return proc(1, "", `unexpected: ${args.join(" ")}`, args);
  };
}

const INSTALLATION_USER_403 = {
  code: 1,
  stdout: '{"message":"Resource not accessible by integration","status":"403"}',
  stderr: "gh: Resource not accessible by integration (HTTP 403)",
};

function writeReadyStory(project: string, storyId: string, issue: number): void {
  const full = join(project, "xbrief", "active", `${storyId}.xbrief.json`);
  mkdirSync(join(project, "xbrief", "active"), { recursive: true });
  writeFileSync(
    full,
    `${JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: {
        id: storyId,
        title: storyId,
        status: "running",
        references: [
          {
            uri: `https://github.com/deftai/directive/issues/${issue}`,
            type: "x-vbrief/github-issue",
          },
        ],
        metadata: { kind: "story", swarm: { readiness: "ready" } },
      },
    })}\n`,
    "utf8",
  );
}

describe("prepareWorkerCredentialInjection (#1351)", () => {
  it("injects a user-bearing credential on the grok-build path and stamps expected login", () => {
    const result = prepareWorkerCredentialInjection({
      environ: { GH_TOKEN: FAKE_TOKEN, GH_REPO: TARGET_REPO },
      githubAuthMode: "injected-token",
      runtimeMode: "cloud-headless",
      dispatchPath: "grok-build",
      runGh: stubGh({}),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.injected).toBe(true);
    expect(result.githubAuthMode).toBe("injected-token");
    expect(result.expectedLogin).toBe(WORKER_LOGIN);
    expect(result.spawnEnv.GH_TOKEN).toBe(FAKE_TOKEN);
    expect(result.spawnEnv[ENV_EXPECTED_GITHUB_LOGIN]).toBe(WORKER_LOGIN);
    expect(result.envelopeSection).toContain("github_auth_mode: injected-token");
    expect(result.envelopeSection).toContain(`expected_github_login: ${WORKER_LOGIN}`);
    expect(result.envelopeSection).not.toContain(FAKE_TOKEN);
  });

  it("injects a held user-bearing credential on the local-hybrid path", () => {
    const result = prepareWorkerCredentialInjection({
      environ: { GITHUB_TOKEN: FAKE_TOKEN, GH_REPO: TARGET_REPO },
      githubAuthMode: "host-gh",
      runtimeMode: "local-unsandboxed",
      dispatchPath: "local-hybrid",
      runGh: stubGh({}),
    });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.injected) {
      return;
    }
    expect(result.githubAuthMode).toBe("injected-token");
    expect(result.spawnEnv.GH_TOKEN).toBe(FAKE_TOKEN);
    expect(result.spawnEnv[ENV_EXPECTED_GITHUB_LOGIN]).toBe(WORKER_LOGIN);
  });

  it("does not inject on authorized host-gh local-hybrid when no token is held", () => {
    const result = prepareWorkerCredentialInjection({
      environ: { GH_REPO: TARGET_REPO },
      githubAuthMode: "host-gh",
      runtimeMode: "local-unsandboxed",
      dispatchPath: "local-hybrid",
      runGh: stubGh({}),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.injected).toBe(false);
    expect(result.githubAuthMode).toBe("host-gh");
    expect(result.spawnEnv).toEqual({});
    expect(result.envelopeSection).toContain("github_auth_mode: host-gh");
    expect(result.envelopeSection).not.toContain("GH_TOKEN");
  });

  it("halts BLOCKED when injected-token has no credential, naming the remedy", () => {
    const result = prepareWorkerCredentialInjection({
      environ: { GH_REPO: TARGET_REPO },
      githubAuthMode: "injected-token",
      runtimeMode: "cloud-headless",
      dispatchPath: "grok-build",
      runGh: stubGh({}),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.blocked).toBe(true);
    expect(result.failureKind).toBe(FAILURE_MISSING_INJECTED_TOKEN);
    expect(result.missingCredential).toMatch(/GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN/);
    expect(result.detail).toMatch(/BLOCKED/i);
    expect(result.remedy).toMatch(/dispatcher/i);
    expect(result.remedy).toMatch(/prepareWorkerCredentialInjection|inject/i);
    expect(result.remedy).toMatch(/Do not fall back to the host gh token/i);
    expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN);
  });

  it("refuses an installation credential instead of injecting it", () => {
    const result = prepareWorkerCredentialInjection({
      environ: { GH_TOKEN: FAKE_TOKEN, GH_REPO: TARGET_REPO },
      githubAuthMode: "injected-token",
      runtimeMode: "cloud-headless",
      dispatchPath: "grok-build",
      runGh: stubGh({ user: INSTALLATION_USER_403 }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.failureKind).toBe(FAILURE_INSTALLATION_IDENTITY_UNVERIFIABLE);
    expect(result.detail).toMatch(/#3693|installation/i);
    expect("spawnEnv" in result).toBe(false);
  });

  it("binds the operator-supplied expected login and fail-closes on mismatch", () => {
    const match = prepareWorkerCredentialInjection({
      environ: {
        GH_TOKEN: FAKE_TOKEN,
        GH_REPO: TARGET_REPO,
        [ENV_EXPECTED_GITHUB_LOGIN]: WORKER_LOGIN,
      },
      githubAuthMode: "injected-token",
      runtimeMode: "cloud-headless",
      dispatchPath: "grok-build",
      runGh: stubGh({}),
    });
    expect(match.ok).toBe(true);
    if (match.ok && match.injected) {
      expect(match.spawnEnv[ENV_EXPECTED_GITHUB_LOGIN]).toBe(WORKER_LOGIN);
    }

    const mismatch = prepareWorkerCredentialInjection({
      environ: {
        GH_TOKEN: FAKE_TOKEN,
        GH_REPO: TARGET_REPO,
        [ENV_EXPECTED_GITHUB_LOGIN]: "someone-else",
      },
      githubAuthMode: "injected-token",
      runtimeMode: "cloud-headless",
      dispatchPath: "grok-build",
      runGh: stubGh({}),
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.failureKind).toBe(FAILURE_PRINCIPAL_MISMATCH);
    }
  });

  it("validates the selected token, not a sibling enterprise token", () => {
    const enterpriseToken = "gho_enterprise_other_principal_1351";
    const seen: {
      ghToken?: string;
      githubToken?: string;
      enterprise?: string;
      configDir?: string;
    } = {};
    const runGh: GhRunner = (args, environ) => {
      seen.ghToken = environ.GH_TOKEN;
      seen.githubToken = environ.GITHUB_TOKEN;
      seen.enterprise = environ.GH_ENTERPRISE_TOKEN;
      seen.configDir = environ.GH_CONFIG_DIR;
      return stubGh({})(args, environ);
    };
    const result = prepareWorkerCredentialInjection({
      environ: {
        GH_TOKEN: FAKE_TOKEN,
        GH_ENTERPRISE_TOKEN: enterpriseToken,
        GH_HOST: "ghe.example.invalid",
        GH_CONFIG_DIR: "/tmp/other-gh-store",
        GH_REPO: TARGET_REPO,
      },
      githubAuthMode: "injected-token",
      runtimeMode: "cloud-headless",
      dispatchPath: "grok-build",
      runGh,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.injected) {
      return;
    }
    expect(result.spawnEnv.GH_TOKEN).toBe(FAKE_TOKEN);
    expect(result.spawnEnv.GITHUB_TOKEN).toBe(FAKE_TOKEN);
    expect(result.spawnEnv.GH_ENTERPRISE_TOKEN).toBe(FAKE_TOKEN);
    expect(result.expectedLogin).toBe(WORKER_LOGIN);
    expect(seen.ghToken).toBe(FAKE_TOKEN);
    expect(seen.githubToken).toBe(FAKE_TOKEN);
    expect(seen.enterprise).toBe(FAKE_TOKEN);
    expect(seen.configDir).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(enterpriseToken);
  });

  it("never continues under host identity from injected-token mode", () => {
    const result = prepareWorkerCredentialInjection({
      environ: { GH_REPO: TARGET_REPO },
      githubAuthMode: "injected-token",
      runtimeMode: "local-unsandboxed",
      dispatchPath: "local-hybrid",
      runGh: stubGh({}),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.remedy).not.toMatch(/use the host|fall back to host/i);
      expect(result.githubAuthMode).toBe("injected-token");
    }
  });
});

describe("formatDispatchAuthEnvelope (#1351)", () => {
  it("records github_auth_mode and expected login without a credential value", () => {
    const section = formatDispatchAuthEnvelope({
      runtimeMode: "cloud-headless",
      githubAuthMode: "injected-token",
      expectedGithubLogin: WORKER_LOGIN,
    });
    expect(section).toContain("## Runtime and GitHub auth mode");
    expect(section).toContain("runtime_mode: cloud-headless");
    expect(section).toContain("github_auth_mode: injected-token");
    expect(section).toContain(`expected_github_login: ${WORKER_LOGIN}`);
    expect(section).not.toContain("GH_TOKEN=");
    expect(section).not.toContain(FAKE_TOKEN);
    expect(section).not.toContain("ghp_");
    expect(section).not.toContain("github_pat_");
  });

  it("omits a blank expected login and rejects a credential-shaped runtime label", () => {
    const omitted = formatDispatchAuthEnvelope({
      runtimeMode: "local-unsandboxed",
      githubAuthMode: "host-gh",
      expectedGithubLogin: "   ",
    });
    expect(omitted).not.toContain("expected_github_login");
    expect(() =>
      formatDispatchAuthEnvelope({
        runtimeMode: FAKE_TOKEN,
        githubAuthMode: "injected-token",
      }),
    ).toThrow(/credential value/i);
  });

  it("collapses newlines in envelope fields so they stay on one bullet", () => {
    const section = formatDispatchAuthEnvelope({
      runtimeMode: "cloud-headless\ninjected",
      githubAuthMode: "injected-token\nextra",
      expectedGithubLogin: `${WORKER_LOGIN}\nnot-a-new-block`,
    });
    expect(section).toContain("runtime_mode: cloud-headless injected");
    expect(section).toContain("github_auth_mode: injected-token extra");
    expect(section).toContain(`expected_github_login: ${WORKER_LOGIN} not-a-new-block`);
    expect(section.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(3);
  });

  it("rejects a credential-shaped expected login", () => {
    expect(() =>
      formatDispatchAuthEnvelope({
        runtimeMode: "cloud-headless",
        githubAuthMode: "injected-token",
        expectedGithubLogin: FAKE_TOKEN,
      }),
    ).toThrow(/credential value/i);
  });
});

describe("buildManifest auth-mode and identity stamps (#1351)", () => {
  it("writes github_auth_mode and expected_github_login without a token value", () => {
    const [entry] = buildManifest([story], {
      projectRoot: "/p",
      dispatchKind: "solo",
      allocationPlanId: null,
      batchingRationale: null,
      operatorApprovalEvidence: null,
      runtimeMode: "cloud-headless",
      githubAuthMode: "injected-token",
      expectedGithubLogin: WORKER_LOGIN,
    });
    expect(entry?.github_auth_mode).toBe("injected-token");
    expect(entry?.expected_github_login).toBe(WORKER_LOGIN);
    expect(entry?.runtime_mode).toBe("cloud-headless");
    const rendered = JSON.stringify(entry);
    expect(rendered).not.toContain(FAKE_TOKEN);
    expect(rendered).not.toContain("ghp_");
    expect(Object.keys(entry ?? {})).not.toContain("GH_TOKEN");
    expect(Object.keys(entry ?? {})).not.toContain("GITHUB_TOKEN");
  });
});

describe("swarmLaunch identity-bound injection (#1351)", () => {
  const savedRouting = process.env.DEFT_ROUTING_PATH;
  const cleanups: string[] = [];
  afterEach(() => {
    if (savedRouting === undefined) {
      delete process.env.DEFT_ROUTING_PATH;
    } else {
      process.env.DEFT_ROUTING_PATH = savedRouting;
    }
    while (cleanups.length > 0) {
      const dir = cleanups.pop();
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function launchProject(): string {
    const project = mkdtempSync(join(tmpdir(), "launch-inject-"));
    cleanups.push(project);
    writeReadyStory(project, "story-a", 1351);
    const routePath = join(project, "routing.local.json");
    writeFileSync(
      routePath,
      JSON.stringify({
        cursor: { "leaf-implementation": { model: "composer-2.5-fast", mode: "pinned" } },
      }),
    );
    process.env.DEFT_ROUTING_PATH = routePath;
    return project;
  }

  it("stamps expected_github_login on the manifest when a user credential is held", () => {
    const project = launchProject();
    const result = swarmLaunch({
      stories: ["1351"],
      projectRoot: project,
      autonomous: true,
      preflightGate: () => ({ exitCode: 0, message: "" }),
      readinessGate: () => ({ exitCode: 0, report: "" }),
      runtimeAuthProbe: () => ["cloud-headless", "injected-token"],
      environ: { CURSOR_AGENT: "1", GH_TOKEN: FAKE_TOKEN, GH_REPO: TARGET_REPO },
      runGh: stubGh({}),
    });
    expect(result.exitCode).toBe(0);
    const manifest = JSON.parse(result.stdout) as Record<string, unknown>[];
    expect(manifest[0]?.github_auth_mode).toBe("injected-token");
    expect(manifest[0]?.expected_github_login).toBe(WORKER_LOGIN);
    expect(result.stdout).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(manifest)).not.toContain(FAKE_TOKEN);
  });

  it("does not auto-promote host-gh to injected-token just because GH_TOKEN is set", () => {
    const project = launchProject();
    const result = swarmLaunch({
      stories: ["1351"],
      projectRoot: project,
      autonomous: true,
      preflightGate: () => ({ exitCode: 0, message: "" }),
      readinessGate: () => ({ exitCode: 0, report: "" }),
      runtimeAuthProbe: () => ["local-unsandboxed", "host-gh"],
      environ: { CURSOR_AGENT: "1", GH_TOKEN: FAKE_TOKEN, GH_REPO: TARGET_REPO },
      runGh: stubGh({}),
    });
    expect(result.exitCode).toBe(0);
    const manifest = JSON.parse(result.stdout) as Record<string, unknown>[];
    expect(manifest[0]?.github_auth_mode).toBe("host-gh");
    expect(manifest[0]?.expected_github_login).toBeUndefined();
    expect(result.stdout).not.toContain(FAKE_TOKEN);
  });

  it("fails launch when injected-token has no credential", () => {
    const project = launchProject();
    const result = swarmLaunch({
      stories: ["1351"],
      projectRoot: project,
      autonomous: true,
      preflightGate: () => ({ exitCode: 0, message: "" }),
      readinessGate: () => ({ exitCode: 0, report: "" }),
      runtimeAuthProbe: () => ["cloud-headless", "injected-token"],
      environ: { CURSOR_AGENT: "1", GH_REPO: TARGET_REPO },
      runGh: stubGh({}),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/BLOCKED/i);
    expect(result.stderr).toMatch(/GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN/);
    expect(result.stderr).toMatch(/dispatcher/i);
    expect(result.stdout).not.toContain(FAKE_TOKEN);
  });

  it("fails launch when the held credential is an installation token", () => {
    const project = launchProject();
    const result = swarmLaunch({
      stories: ["1351"],
      projectRoot: project,
      autonomous: true,
      preflightGate: () => ({ exitCode: 0, message: "" }),
      readinessGate: () => ({ exitCode: 0, report: "" }),
      runtimeAuthProbe: () => ["cloud-headless", "injected-token"],
      environ: { CURSOR_AGENT: "1", GH_TOKEN: FAKE_TOKEN, GH_REPO: TARGET_REPO },
      runGh: stubGh({ user: INSTALLATION_USER_403 }),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/BLOCKED/i);
    expect(result.stderr).toMatch(/installation|#3693/i);
    expect(result.stdout).not.toContain(FAKE_TOKEN);
  });
});

describe("swarmLaunch occupancy-before-create (#3649)", () => {
  const savedRouting = process.env.DEFT_ROUTING_PATH;
  const cleanups: string[] = [];
  afterEach(() => {
    if (savedRouting === undefined) {
      delete process.env.DEFT_ROUTING_PATH;
    } else {
      process.env.DEFT_ROUTING_PATH = savedRouting;
    }
    while (cleanups.length > 0) {
      const dir = cleanups.pop();
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function launchProject(): string {
    const project = mkdtempSync(join(tmpdir(), "launch-occ-"));
    cleanups.push(project);
    writeReadyStory(project, "story-a", 3649);
    const routePath = join(project, "routing.local.json");
    writeFileSync(
      routePath,
      JSON.stringify({
        cursor: { "leaf-implementation": { model: "composer-2.5-fast", mode: "pinned" } },
      }),
    );
    process.env.DEFT_ROUTING_PATH = routePath;
    return project;
  }

  it("denies a foreign occupant before creating a mapped worktree", () => {
    const project = launchProject();
    applyWorktreeOccupancy(project, { sessionId: "foreign-owner", intent: "swarm" });
    const missing = join(project, "wt-missing");
    const mapPath = join(project, "worktree-map.json");
    writeFileSync(
      mapPath,
      JSON.stringify([
        {
          story_id: "story-a",
          worktree_path: missing.replace(/\\/g, "/"),
          base_branch: "master",
        },
      ]),
    );
    let resolverCalls = 0;
    const result = swarmLaunch({
      stories: ["3649"],
      projectRoot: project,
      autonomous: true,
      worktreeMap: mapPath,
      baseBranch: "master",
      preflightGate: () => ({ exitCode: 0, message: "" }),
      readinessGate: () => ({ exitCode: 0, report: "" }),
      runtimeAuthProbe: () => ["local-unsandboxed", "host-gh"],
      worktreeResolver: () => {
        resolverCalls += 1;
        throw new Error("worktree resolver must not run after occupancy deny");
      },
      environ: { CURSOR_AGENT: "1" },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/occupied|occupancy/i);
    expect(resolverCalls).toBe(0);
    expect(existsSync(missing)).toBe(false);
    expect(readOccupancy(project)?.sessionId).toBe("foreign-owner");
  });

  it("releases a newly claimed lease when a later step fails", () => {
    const project = launchProject();
    const mapPath = join(project, "worktree-map.json");
    writeFileSync(mapPath, "{}\n");
    const result = swarmLaunch({
      stories: ["3649"],
      projectRoot: project,
      autonomous: true,
      worktreeMap: mapPath,
      preflightGate: () => ({ exitCode: 0, message: "" }),
      readinessGate: () => ({ exitCode: 0, report: "" }),
      runtimeAuthProbe: () => ["local-unsandboxed", "host-gh"],
      environ: { CURSOR_AGENT: "1" },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/worktree-map|JSON array/i);
    expect(existsSync(occupancyPath(project))).toBe(false);
    expect(readOccupancy(project)).toBeNull();
  });

  it("does not release a heartbeat on an existing owner after a later failure", () => {
    const project = launchProject();
    applyWorktreeOccupancy(project, { sessionId: "owner", intent: "mutation" });
    const mapPath = join(project, "worktree-map.json");
    writeFileSync(mapPath, "{}\n");
    const result = swarmLaunch({
      stories: ["3649"],
      projectRoot: project,
      autonomous: true,
      worktreeMap: mapPath,
      preflightGate: () => ({ exitCode: 0, message: "" }),
      readinessGate: () => ({ exitCode: 0, report: "" }),
      runtimeAuthProbe: () => ["local-unsandboxed", "host-gh"],
      environ: { CURSOR_AGENT: "1", DEFT_SESSION_ID: "owner" },
    });
    expect(result.exitCode).not.toBe(0);
    expect(readOccupancy(project)?.sessionId).toBe("owner");
    expect(existsSync(occupancyPath(project))).toBe(true);
  });
});

describe("preamble envelope half of the auth-mode contract (#1351)", () => {
  const preamble = readFileSync(PREAMBLE_PATH, "utf8");

  it("documents github_auth_mode on the dispatch envelope and keeps the :451 / :127 conjunction", () => {
    expect(preamble).toContain("github_auth_mode");
    expect(preamble).toContain("expected_github_login");
    expect(preamble).toContain(ENV_EXPECTED_GITHUB_LOGIN);
    expect(preamble).toContain(
      "These fields are policy labels only -- they MUST NOT contain `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, or any secret token value.",
    );
    expect(preamble).toContain(
      "Dispatchers MUST inject worker credentials for injected-token / cloud-headless dispatches and MUST record the selected `github_auth_mode` in the launch manifest and dispatch envelope. v1 deliberately keeps token injection operator-implemented; mode labels make the contract explicit without placing token values in prompts or transcripts.",
    );
    expect(preamble).toContain("prepareWorkerCredentialInjection");
    expect(preamble).toContain("validateGithubAuthForWorker");
    expect(preamble).not.toContain("ghp_");
    expect(preamble).not.toContain("github_pat_");
    expect(preamble).not.toContain(FAKE_TOKEN);
  });
});
