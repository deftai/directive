import { type CompletedProcess, call } from "../scm/call.js";
import { pyRepr } from "../scm/py-format.js";
import {
  getPlatformCapabilities,
  probeRuntimeCapabilities,
  RUNTIME_MODE_CLOUD_HEADLESS,
  RUNTIME_MODE_CURSOR_NATIVE_SANDBOX,
  type RuntimeCapabilityReport,
} from "./platform-capabilities.js";

export const GITHUB_AUTH_MODE_INJECTED_TOKEN = "injected-token";
export const GITHUB_AUTH_MODE_HOST_GH = "host-gh";

export const KNOWN_GITHUB_AUTH_MODES = new Set<string>([
  GITHUB_AUTH_MODE_INJECTED_TOKEN,
  GITHUB_AUTH_MODE_HOST_GH,
]);

export const DEFAULT_VALIDATION_REPO = "deftai/directive";

export const FAILURE_MISSING_INJECTED_TOKEN = "missing_injected_token";
export const FAILURE_GH_AUTH = "gh_auth_failed";
export const FAILURE_API_UNREACHABLE = "api_unreachable";
export const FAILURE_REPO_ACCESS = "repo_access_denied";
export const FAILURE_INVALID_MODE = "invalid_auth_mode";

const INJECTED_TOKEN_ENV_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"] as const;

const SANDBOX_REMEDIATION =
  "Remediation options for worker sandbox GitHub auth failures:\n" +
  "  - Run the GitHub step with full-access execution\n" +
  "  - Allowlist the trusted gh command path for the worker sandbox\n" +
  "  - Use injected-token handoff (keep token values out of prompts and transcripts)";

const REPO_ACCESS_REMEDIATION =
  "Remediation options for repo-access failures:\n" +
  "  - Confirm the worker credential can read the target repository\n" +
  "  - Run the GitHub step with full-access execution if host gh has access\n" +
  "  - Use injected-token handoff scoped to the required repository";

export interface GitHubAuthValidationResult {
  readonly ok: boolean;
  readonly githubAuthMode: string;
  readonly runtimeMode: string | null;
  readonly failureKind: string | null;
  readonly detail: string;
  readonly remediation: string | null;
  readonly login: string | null;
}

export type GhRunner = (args: readonly string[], environ: NodeJS.ProcessEnv) => CompletedProcess;

export function findInjectedToken(environ: NodeJS.ProcessEnv): string | null {
  for (const name of INJECTED_TOKEN_ENV_VARS) {
    const value = environ[name]?.trim() ?? "";
    if (value.length > 0) {
      return value;
    }
  }
  return null;
}

export function inferGithubAuthMode(runtimeReport: RuntimeCapabilityReport): string {
  if (runtimeReport.runtimeMode === RUNTIME_MODE_CLOUD_HEADLESS) {
    return GITHUB_AUTH_MODE_INJECTED_TOKEN;
  }
  return GITHUB_AUTH_MODE_HOST_GH;
}

function defaultRunGh(args: readonly string[], environ: NodeJS.ProcessEnv): CompletedProcess {
  const verb = args[0] as string;
  return call("github-issue", verb, args.slice(1), { env: environ, timeout: 30 });
}

function splitRepo(repo: string): [string, string] {
  const idx = repo.indexOf("/");
  if (idx <= 0 || idx >= repo.length - 1) {
    throw new Error(`invalid repository slug: ${JSON.stringify(repo)} (expected owner/repo)`);
  }
  return [repo.slice(0, idx), repo.slice(idx + 1)];
}

function sandboxRemediation(runtimeMode: string | null, failureKind: string): string | null {
  if (runtimeMode !== RUNTIME_MODE_CURSOR_NATIVE_SANDBOX) {
    return null;
  }
  if (
    failureKind === FAILURE_GH_AUTH ||
    failureKind === FAILURE_API_UNREACHABLE ||
    failureKind === FAILURE_REPO_ACCESS
  ) {
    return SANDBOX_REMEDIATION;
  }
  return null;
}

function repoAccessRemediation(failureKind: string): string | null {
  return failureKind === FAILURE_REPO_ACCESS ? REPO_ACCESS_REMEDIATION : null;
}

function mergeRemediation(runtimeMode: string | null, failureKind: string): string | null {
  const parts: string[] = [];
  const sandbox = sandboxRemediation(runtimeMode, failureKind);
  if (sandbox !== null) {
    parts.push(sandbox);
  }
  const repo = repoAccessRemediation(failureKind);
  if (repo !== null && !parts.includes(repo)) {
    parts.push(repo);
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

function parseLogin(stdout: string): string | null {
  const text = stdout.trim();
  if (text.length === 0) {
    return null;
  }
  try {
    const payload = JSON.parse(text) as unknown;
    if (typeof payload === "string" && payload.length > 0) {
      return payload;
    }
    if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
      const login = (payload as Record<string, unknown>).login;
      if (typeof login === "string" && login.length > 0) {
        return login;
      }
    }
  } catch {
    return text;
  }
  return null;
}

export function validateInjectedTokenMode(
  environ: NodeJS.ProcessEnv,
  options: {
    repo?: string;
    runtimeMode?: string | null;
    runGh?: GhRunner;
  } = {},
): GitHubAuthValidationResult {
  const runner = options.runGh ?? defaultRunGh;
  const repo = options.repo ?? DEFAULT_VALIDATION_REPO;
  const runtimeMode = options.runtimeMode ?? null;
  const token = findInjectedToken(environ);
  if (token === null) {
    return {
      ok: false,
      githubAuthMode: GITHUB_AUTH_MODE_INJECTED_TOKEN,
      runtimeMode,
      failureKind: FAILURE_MISSING_INJECTED_TOKEN,
      detail:
        "injected-token mode requires GH_TOKEN, GITHUB_TOKEN, or GH_ENTERPRISE_TOKEN; host gh credential store is not used",
      remediation: null,
      login: null,
    };
  }

  const authStatus = runner(["auth", "status"], environ);
  if (authStatus.returncode !== 0) {
    return {
      ok: false,
      githubAuthMode: GITHUB_AUTH_MODE_INJECTED_TOKEN,
      runtimeMode,
      failureKind: FAILURE_GH_AUTH,
      detail: "injected token present but gh auth status failed in worker",
      remediation: mergeRemediation(runtimeMode, FAILURE_GH_AUTH),
      login: null,
    };
  }

  const userApi = runner(["api", "user", "--jq", ".login"], environ);
  if (userApi.returncode !== 0) {
    return {
      ok: false,
      githubAuthMode: GITHUB_AUTH_MODE_INJECTED_TOKEN,
      runtimeMode,
      failureKind: FAILURE_API_UNREACHABLE,
      detail: "injected token present but GitHub API is unreachable",
      remediation: mergeRemediation(runtimeMode, FAILURE_API_UNREACHABLE),
      login: null,
    };
  }

  const login = parseLogin(userApi.stdout);
  const [owner, name] = splitRepo(repo);
  const repoApi = runner(["api", `repos/${owner}/${name}`], environ);
  if (repoApi.returncode !== 0) {
    return {
      ok: false,
      githubAuthMode: GITHUB_AUTH_MODE_INJECTED_TOKEN,
      runtimeMode,
      failureKind: FAILURE_REPO_ACCESS,
      detail: `injected token can reach GitHub API but cannot access ${repo}`,
      remediation: mergeRemediation(runtimeMode, FAILURE_REPO_ACCESS),
      login,
    };
  }

  return {
    ok: true,
    githubAuthMode: GITHUB_AUTH_MODE_INJECTED_TOKEN,
    runtimeMode,
    failureKind: null,
    detail: "injected-token mode validated in worker environment",
    remediation: null,
    login,
  };
}

export function validateHostGhMode(
  environ: NodeJS.ProcessEnv,
  options: {
    repo?: string;
    runtimeMode?: string | null;
    runGh?: GhRunner;
  } = {},
): GitHubAuthValidationResult {
  const runner = options.runGh ?? defaultRunGh;
  const repo = options.repo ?? DEFAULT_VALIDATION_REPO;
  const runtimeMode = options.runtimeMode ?? null;

  const authStatus = runner(["auth", "status"], environ);
  if (authStatus.returncode !== 0) {
    return {
      ok: false,
      githubAuthMode: GITHUB_AUTH_MODE_HOST_GH,
      runtimeMode,
      failureKind: FAILURE_GH_AUTH,
      detail: "gh auth status failed in worker environment",
      remediation: mergeRemediation(runtimeMode, FAILURE_GH_AUTH),
      login: null,
    };
  }

  const userApi = runner(["api", "user", "--jq", ".login"], environ);
  if (userApi.returncode !== 0) {
    return {
      ok: false,
      githubAuthMode: GITHUB_AUTH_MODE_HOST_GH,
      runtimeMode,
      failureKind: FAILURE_API_UNREACHABLE,
      detail: "gh auth status passed but GitHub API is unreachable",
      remediation: mergeRemediation(runtimeMode, FAILURE_API_UNREACHABLE),
      login: null,
    };
  }

  const [owner, name] = splitRepo(repo);
  const repoApi = runner(["api", `repos/${owner}/${name}`], environ);
  if (repoApi.returncode !== 0) {
    return {
      ok: false,
      githubAuthMode: GITHUB_AUTH_MODE_HOST_GH,
      runtimeMode,
      failureKind: FAILURE_REPO_ACCESS,
      detail: `GitHub API reachable but repository access failed for ${repo}`,
      remediation: mergeRemediation(runtimeMode, FAILURE_REPO_ACCESS),
      login: parseLogin(userApi.stdout),
    };
  }

  return {
    ok: true,
    githubAuthMode: GITHUB_AUTH_MODE_HOST_GH,
    runtimeMode,
    failureKind: null,
    detail: "host-gh mode validated in worker environment",
    remediation: null,
    login: parseLogin(userApi.stdout),
  };
}

export function validateGithubAuth(
  githubAuthMode: string,
  options: {
    environ?: NodeJS.ProcessEnv;
    runtimeReport?: RuntimeCapabilityReport | null;
    repo?: string;
    runGh?: GhRunner;
  } = {},
): GitHubAuthValidationResult {
  const env = options.environ ?? process.env;
  const runtimeMode = options.runtimeReport?.runtimeMode ?? null;

  if (!KNOWN_GITHUB_AUTH_MODES.has(githubAuthMode)) {
    return {
      ok: false,
      githubAuthMode,
      runtimeMode,
      failureKind: FAILURE_INVALID_MODE,
      detail: `unknown github_auth_mode ${pyRepr(githubAuthMode)}; expected one of ${pyRepr([...KNOWN_GITHUB_AUTH_MODES].sort())}`,
      remediation: null,
      login: null,
    };
  }

  if (githubAuthMode === GITHUB_AUTH_MODE_INJECTED_TOKEN) {
    return validateInjectedTokenMode(env, {
      repo: options.repo,
      runtimeMode,
      runGh: options.runGh,
    });
  }
  return validateHostGhMode(env, {
    repo: options.repo,
    runtimeMode,
    runGh: options.runGh,
  });
}

export function validateGithubAuthForWorker(
  githubAuthMode: string | null = null,
  options: {
    environ?: NodeJS.ProcessEnv;
    runtimeReport?: RuntimeCapabilityReport | null;
    repo?: string;
    runGh?: GhRunner;
  } = {},
): GitHubAuthValidationResult {
  const report = options.runtimeReport ?? getPlatformCapabilities();
  const mode = githubAuthMode ?? inferGithubAuthMode(report);
  return validateGithubAuth(mode, { ...options, runtimeReport: report });
}

export function resultToDict(result: GitHubAuthValidationResult): Record<string, unknown> {
  return {
    ok: result.ok,
    github_auth_mode: result.githubAuthMode,
    runtime_mode: result.runtimeMode,
    failure_kind: result.failureKind,
    detail: result.detail,
    remediation: result.remediation,
    login: result.login,
  };
}

export interface GitHubAuthModesCliArgs {
  githubAuthMode?: string | null;
  repo?: string;
  json?: boolean;
}

export function githubAuthModesMain(args: GitHubAuthModesCliArgs): number {
  const result = validateGithubAuthForWorker(args.githubAuthMode ?? null, {
    repo: args.repo ?? DEFAULT_VALIDATION_REPO,
  });
  if (args.json) {
    process.stdout.write(`${JSON.stringify(resultToDict(result), null, 2)}\n`);
  } else {
    const status = result.ok ? "ok" : "failed";
    process.stdout.write(`github_auth_mode=${result.githubAuthMode} status=${status}\n`);
    process.stdout.write(`detail=${result.detail}\n`);
    if (result.remediation !== null) {
      process.stdout.write(`${result.remediation}\n`);
    }
  }
  return result.ok ? 0 : 1;
}

export { probeRuntimeCapabilities };
