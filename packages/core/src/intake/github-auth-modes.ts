import { spawnSync } from "node:child_process";
import type { CompletedProcess } from "../scm/call.js";
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

export const PRINCIPAL_KIND_USER = "user";

export const FAILURE_MISSING_INJECTED_TOKEN = "missing_injected_token";
export const FAILURE_GH_AUTH = "gh_auth_failed";
export const FAILURE_API_UNREACHABLE = "api_unreachable";
export const FAILURE_REPO_ACCESS = "repo_access_denied";
export const FAILURE_INVALID_MODE = "invalid_auth_mode";
export const FAILURE_MISSING_EXPECTED_PRINCIPAL = "missing_expected_principal";
export const FAILURE_PRINCIPAL_MISMATCH = "principal_mismatch";
export const FAILURE_MISSING_TARGET_REPO = "missing_target_repo";
export const FAILURE_INSTALLATION_IDENTITY_UNVERIFIABLE = "installation_identity_unverifiable";

export const ENV_EXPECTED_GITHUB_LOGIN = "DEFT_EXPECTED_GITHUB_LOGIN";

export const INSTALLATION_IDENTITY_ISSUE_URL = "https://github.com/deftai/directive/issues/3693";

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

const PRINCIPAL_REMEDIATION =
  "Remediation for GitHub worker-principal failures:\n" +
  "  - User-bearing credential: pass expectedPrincipal.login or set DEFT_EXPECTED_GITHUB_LOGIN\n" +
  "  - Do not treat a /user 403 on an installation token as API unreachability\n" +
  "  - GitHub App installation identity cannot be verified from the token; see #3693";

const INSTALLATION_IDENTITY_REMEDIATION =
  "A GitHub App installation token cannot prove which App it belongs to.\n" +
  `Tracked in ${INSTALLATION_IDENTITY_ISSUE_URL}. Do not treat a /user 403 as API unreachability.`;

const TARGET_REPO_REMEDIATION =
  "Remediation for missing target repository:\n" +
  "  - Pass repo as owner/repo, or set GH_REPO / GITHUB_REPOSITORY, or run inside a git checkout with origin\n" +
  "  - Do not fall back to a hard-coded public default";

/** GitHub-specific expected worker principal. Not a universal (provider-neutral) identity. */
export type ExpectedGithubWorkerPrincipal = { readonly kind: "user"; readonly login: string };

export interface GitHubAuthValidationResult {
  readonly ok: boolean;
  readonly githubAuthMode: string;
  readonly runtimeMode: string | null;
  readonly failureKind: string | null;
  readonly detail: string;
  readonly remediation: string | null;
  readonly login: string | null;
  readonly principal: ExpectedGithubWorkerPrincipal | null;
  readonly validationRepo: string | null;
}

export type GhRunner = (args: readonly string[], environ: NodeJS.ProcessEnv) => CompletedProcess;
export type GitRemoteReader = (cwd?: string) => string | null;

export interface GithubAuthValidationOptions {
  repo?: string;
  runtimeMode?: string | null;
  runGh?: GhRunner;
  expectedPrincipal?: ExpectedGithubWorkerPrincipal | null;
  gitRemoteUrl?: string | null;
  readGitRemote?: GitRemoteReader;
  cwd?: string;
}

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

/**
 * Prefer live `gh` for auth/API validation. Do not route through scm.call /
 * BINARY_PREFERENCE (ghx-first): ghx is a cached GET proxy and rejects multi-arg
 * `api user --jq .login` forms used here (#2275 Greptile P1 / #954).
 */
function defaultRunGh(args: readonly string[], environ: NodeJS.ProcessEnv): CompletedProcess {
  const binary = "gh";
  try {
    const result = spawnSync(binary, [...args], {
      env: environ,
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      args: [binary, ...args],
      returncode: result.status ?? 1,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { args: [binary, ...args], returncode: 1, stdout: "", stderr: message };
  }
}

export function defaultReadGitOriginUrl(cwd?: string): string | null {
  try {
    const result = spawnSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if ((result.status ?? 1) !== 0) {
      return null;
    }
    const url = (typeof result.stdout === "string" ? result.stdout : "").trim();
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

export function parseOwnerRepoSlug(input: string): string | null {
  const raw = input.trim();
  if (raw.length === 0) {
    return null;
  }
  const direct = raw.match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/);
  if (direct) {
    return `${direct[1]}/${direct[2]}`;
  }
  const stripped = raw.replace(/\.git$/i, "");
  // SCP form including GitHub Enterprise: git@host:owner/repo
  if (!stripped.includes("://")) {
    const scp = stripped.match(/:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/);
    if (scp) {
      return `${scp[1]}/${scp[2]}`;
    }
  }
  const fromUrl = stripped.match(/[:/]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/);
  if (fromUrl) {
    return `${fromUrl[1]}/${fromUrl[2]}`;
  }
  return null;
}

export function deriveValidationRepo(options: {
  repo?: string;
  environ?: NodeJS.ProcessEnv;
  gitRemoteUrl?: string | null;
  readGitRemote?: GitRemoteReader;
  cwd?: string;
}): { ok: true; repo: string } | { ok: false; detail: string } {
  if (options.repo !== undefined && options.repo !== null) {
    const parsed = parseOwnerRepoSlug(options.repo);
    if (parsed === null) {
      return {
        ok: false,
        detail: `invalid repository slug: ${JSON.stringify(options.repo)} (expected owner/repo)`,
      };
    }
    return { ok: true, repo: parsed };
  }
  const env = options.environ ?? {};
  const fromEnv = (env.GH_REPO ?? env.GITHUB_REPOSITORY ?? "").trim();
  if (fromEnv.length > 0) {
    const parsed = parseOwnerRepoSlug(fromEnv);
    if (parsed === null) {
      return {
        ok: false,
        detail: `invalid repository slug from GH_REPO/GITHUB_REPOSITORY: ${JSON.stringify(fromEnv)}`,
      };
    }
    return { ok: true, repo: parsed };
  }
  const remote =
    options.gitRemoteUrl !== undefined && options.gitRemoteUrl !== null
      ? options.gitRemoteUrl
      : (options.readGitRemote ?? defaultReadGitOriginUrl)(options.cwd);
  if (typeof remote === "string" && remote.trim().length > 0) {
    const parsed = parseOwnerRepoSlug(remote);
    if (parsed === null) {
      return {
        ok: false,
        detail: `invalid git origin URL for repository derivation: ${JSON.stringify(remote.trim())}`,
      };
    }
    return { ok: true, repo: parsed };
  }
  return {
    ok: false,
    detail:
      "cannot derive target repository; pass repo as owner/repo, set GH_REPO or GITHUB_REPOSITORY, or run inside a git checkout with origin",
  };
}

export function resolveExpectedGithubWorkerPrincipal(
  environ: NodeJS.ProcessEnv,
  explicit?: ExpectedGithubWorkerPrincipal | null,
): ExpectedGithubWorkerPrincipal | { error: string } | null {
  if (explicit === null) {
    return null;
  }
  if (explicit !== undefined) {
    return normalizeExpectedPrincipal(explicit);
  }
  const login = environ[ENV_EXPECTED_GITHUB_LOGIN]?.trim() ?? "";
  if (login.length > 0) {
    return { kind: PRINCIPAL_KIND_USER, login };
  }
  return null;
}

function normalizeExpectedPrincipal(
  principal: ExpectedGithubWorkerPrincipal,
): ExpectedGithubWorkerPrincipal | { error: string } {
  if (principal.kind !== PRINCIPAL_KIND_USER) {
    return {
      error: `unknown expected principal kind ${pyRepr((principal as { kind: string }).kind)}`,
    };
  }
  const login = principal.login.trim();
  if (login.length === 0) {
    return { error: "user principal requires a non-empty login" };
  }
  return { kind: PRINCIPAL_KIND_USER, login };
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
    failureKind === FAILURE_REPO_ACCESS ||
    failureKind === FAILURE_MISSING_EXPECTED_PRINCIPAL ||
    failureKind === FAILURE_PRINCIPAL_MISMATCH ||
    failureKind === FAILURE_MISSING_TARGET_REPO ||
    failureKind === FAILURE_INSTALLATION_IDENTITY_UNVERIFIABLE
  ) {
    return SANDBOX_REMEDIATION;
  }
  return null;
}

function extraRemediation(failureKind: string): string | null {
  if (failureKind === FAILURE_REPO_ACCESS) {
    return REPO_ACCESS_REMEDIATION;
  }
  if (failureKind === FAILURE_INSTALLATION_IDENTITY_UNVERIFIABLE) {
    return INSTALLATION_IDENTITY_REMEDIATION;
  }
  if (
    failureKind === FAILURE_MISSING_EXPECTED_PRINCIPAL ||
    failureKind === FAILURE_PRINCIPAL_MISMATCH
  ) {
    return PRINCIPAL_REMEDIATION;
  }
  if (failureKind === FAILURE_MISSING_TARGET_REPO) {
    return TARGET_REPO_REMEDIATION;
  }
  return null;
}

function mergeRemediation(runtimeMode: string | null, failureKind: string): string | null {
  const parts: string[] = [];
  const sandbox = sandboxRemediation(runtimeMode, failureKind);
  if (sandbox !== null) {
    parts.push(sandbox);
  }
  const extra = extraRemediation(failureKind);
  if (extra !== null && !parts.includes(extra)) {
    parts.push(extra);
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

function combinedGhText(proc: CompletedProcess): string {
  return `${proc.stdout}\n${proc.stderr}`;
}

export function isInstallationUserEndpointInapplicable(proc: CompletedProcess): boolean {
  const blob = combinedGhText(proc).toLowerCase();
  return (
    blob.includes("resource not accessible by integration") ||
    blob.includes("not accessible by integration")
  );
}

function clipFailureText(text: string, max = 240): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length === 0) {
    return "";
  }
  if (compact.length <= max) {
    return compact;
  }
  return `${compact.slice(0, max - 3)}...`;
}

function parseGhApiMessage(proc: CompletedProcess): string | null {
  for (const chunk of [proc.stdout, proc.stderr]) {
    const text = chunk.trim();
    if (text.length === 0) {
      continue;
    }
    try {
      const payload = JSON.parse(text) as unknown;
      if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
        const message = (payload as Record<string, unknown>).message;
        if (typeof message === "string" && message.length > 0) {
          const status = (payload as Record<string, unknown>).status;
          if (typeof status === "string" || typeof status === "number") {
            return `${message} (HTTP ${status})`;
          }
          return message;
        }
      }
    } catch {
      // fall through to raw text
    }
  }
  return null;
}

function isNetworkUnreachableText(text: string): boolean {
  return /timed out|timeout|econnrefused|enotfound|eai_again|network is unreachable|could not resolve host/i.test(
    text,
  );
}

export function formatUserApiFailureDetail(mode: string, proc: CompletedProcess): string {
  const parsed = parseGhApiMessage(proc);
  const raw = clipFailureText(combinedGhText(proc));
  const cause = parsed ?? (raw.length > 0 ? raw : `exit ${proc.returncode}`);
  const prefix =
    mode === GITHUB_AUTH_MODE_INJECTED_TOKEN
      ? "injected token present but GitHub /user failed"
      : "gh auth status passed but GitHub /user failed";
  if (isNetworkUnreachableText(cause) || isNetworkUnreachableText(raw)) {
    return `${prefix}: GitHub API is unreachable (${cause})`;
  }
  return `${prefix}: ${cause}`;
}

function emptyResult(
  mode: string,
  runtimeMode: string | null,
  failureKind: string | null,
  detail: string,
  options: {
    ok?: boolean;
    login?: string | null;
    principal?: ExpectedGithubWorkerPrincipal | null;
    validationRepo?: string | null;
  } = {},
): GitHubAuthValidationResult {
  const ok = options.ok ?? false;
  return {
    ok,
    githubAuthMode: mode,
    runtimeMode,
    failureKind: ok ? null : failureKind,
    detail,
    remediation: ok ? null : mergeRemediation(runtimeMode, failureKind ?? ""),
    login: options.login ?? null,
    principal: options.principal ?? null,
    validationRepo: options.validationRepo ?? null,
  };
}

function loginsMatch(expected: string, observed: string): boolean {
  return expected.localeCompare(observed, undefined, { sensitivity: "accent" }) === 0;
}

function failClosedInstallationCredential(
  mode: string,
  runtimeMode: string | null,
  repo: string,
): GitHubAuthValidationResult {
  return emptyResult(
    mode,
    runtimeMode,
    FAILURE_INSTALLATION_IDENTITY_UNVERIFIABLE,
    "GitHub /user is inapplicable to a GitHub App installation credential (no authenticated user). " +
      "The API is reachable. An installation token cannot disclose which App it belongs to, " +
      `so identity cannot be verified. Deferred to ${INSTALLATION_IDENTITY_ISSUE_URL}.`,
    { validationRepo: repo },
  );
}

function checkTargetRepoAccess(
  mode: string,
  runtimeMode: string | null,
  runner: GhRunner,
  environ: NodeJS.ProcessEnv,
  repo: string,
  login: string | null,
  principal: ExpectedGithubWorkerPrincipal | null,
): GitHubAuthValidationResult {
  const [owner, name] = splitRepo(repo);
  const repoApi = runner(["api", `repos/${owner}/${name}`], environ);
  if (repoApi.returncode !== 0) {
    const detail =
      mode === GITHUB_AUTH_MODE_INJECTED_TOKEN
        ? `injected token can reach GitHub API but cannot access ${repo}`
        : `GitHub API reachable but repository access failed for ${repo}`;
    return emptyResult(mode, runtimeMode, FAILURE_REPO_ACCESS, detail, {
      login,
      principal,
      validationRepo: repo,
    });
  }
  const okDetail =
    mode === GITHUB_AUTH_MODE_INJECTED_TOKEN
      ? "injected-token mode validated in worker environment"
      : "host-gh mode validated in worker environment";
  return emptyResult(mode, runtimeMode, null, okDetail, {
    ok: true,
    login,
    principal,
    validationRepo: repo,
  });
}

function validateAfterAuth(
  mode: string,
  environ: NodeJS.ProcessEnv,
  options: GithubAuthValidationOptions,
  runtimeMode: string | null,
  runner: GhRunner,
): GitHubAuthValidationResult {
  const derived = deriveValidationRepo({
    repo: options.repo,
    environ,
    gitRemoteUrl: options.gitRemoteUrl,
    readGitRemote: options.readGitRemote,
    cwd: options.cwd,
  });
  if (!derived.ok) {
    return emptyResult(mode, runtimeMode, FAILURE_MISSING_TARGET_REPO, derived.detail);
  }
  const repo = derived.repo;
  const expectedPrincipal = resolveExpectedGithubWorkerPrincipal(
    environ,
    options.expectedPrincipal,
  );
  if (expectedPrincipal !== null && "error" in expectedPrincipal && options.expectedPrincipal) {
    return emptyResult(
      mode,
      runtimeMode,
      FAILURE_MISSING_EXPECTED_PRINCIPAL,
      expectedPrincipal.error,
      {
        validationRepo: repo,
      },
    );
  }

  const userApi = runner(["api", "user"], environ);
  if (userApi.returncode !== 0) {
    if (isInstallationUserEndpointInapplicable(userApi)) {
      return failClosedInstallationCredential(mode, runtimeMode, repo);
    }
    return emptyResult(
      mode,
      runtimeMode,
      FAILURE_API_UNREACHABLE,
      formatUserApiFailureDetail(mode, userApi),
      { validationRepo: repo },
    );
  }

  const login = parseLogin(userApi.stdout);
  if (login === null) {
    return emptyResult(
      mode,
      runtimeMode,
      FAILURE_PRINCIPAL_MISMATCH,
      "GitHub /user succeeded but returned no login",
      { validationRepo: repo },
    );
  }

  if (expectedPrincipal !== null && "error" in expectedPrincipal) {
    return emptyResult(
      mode,
      runtimeMode,
      FAILURE_MISSING_EXPECTED_PRINCIPAL,
      expectedPrincipal.error,
      {
        login,
        validationRepo: repo,
      },
    );
  }

  if (expectedPrincipal !== null) {
    if (!loginsMatch(expectedPrincipal.login, login)) {
      return emptyResult(
        mode,
        runtimeMode,
        FAILURE_PRINCIPAL_MISMATCH,
        `identity mismatch: expected ${expectedPrincipal.login}, observed ${login}`,
        { login, validationRepo: repo },
      );
    }
  }

  const principal: ExpectedGithubWorkerPrincipal = { kind: PRINCIPAL_KIND_USER, login };
  return checkTargetRepoAccess(mode, runtimeMode, runner, environ, repo, login, principal);
}

export function validateInjectedTokenMode(
  environ: NodeJS.ProcessEnv,
  options: GithubAuthValidationOptions = {},
): GitHubAuthValidationResult {
  const runner = options.runGh ?? defaultRunGh;
  const runtimeMode = options.runtimeMode ?? null;
  const tokenPresent = findInjectedToken(environ) !== null;
  if (!tokenPresent) {
    return emptyResult(
      GITHUB_AUTH_MODE_INJECTED_TOKEN,
      runtimeMode,
      FAILURE_MISSING_INJECTED_TOKEN,
      "injected-token mode requires GH_TOKEN, GITHUB_TOKEN, or GH_ENTERPRISE_TOKEN; host gh credential store is not used",
    );
  }

  const authStatus = runner(["auth", "status"], environ);
  if (authStatus.returncode !== 0) {
    return emptyResult(
      GITHUB_AUTH_MODE_INJECTED_TOKEN,
      runtimeMode,
      FAILURE_GH_AUTH,
      "injected token present but gh auth status failed in worker",
    );
  }

  return validateAfterAuth(GITHUB_AUTH_MODE_INJECTED_TOKEN, environ, options, runtimeMode, runner);
}

export function validateHostGhMode(
  environ: NodeJS.ProcessEnv,
  options: GithubAuthValidationOptions = {},
): GitHubAuthValidationResult {
  const runner = options.runGh ?? defaultRunGh;
  const runtimeMode = options.runtimeMode ?? null;

  const authStatus = runner(["auth", "status"], environ);
  if (authStatus.returncode !== 0) {
    return emptyResult(
      GITHUB_AUTH_MODE_HOST_GH,
      runtimeMode,
      FAILURE_GH_AUTH,
      "gh auth status failed in worker environment",
    );
  }

  return validateAfterAuth(GITHUB_AUTH_MODE_HOST_GH, environ, options, runtimeMode, runner);
}

export function validateGithubAuth(
  githubAuthMode: string,
  options: {
    environ?: NodeJS.ProcessEnv;
    runtimeReport?: RuntimeCapabilityReport | null;
    repo?: string;
    runGh?: GhRunner;
    expectedPrincipal?: ExpectedGithubWorkerPrincipal | null;
    gitRemoteUrl?: string | null;
    readGitRemote?: GitRemoteReader;
    cwd?: string;
  } = {},
): GitHubAuthValidationResult {
  const env = options.environ ?? process.env;
  const runtimeMode = options.runtimeReport?.runtimeMode ?? null;

  if (!KNOWN_GITHUB_AUTH_MODES.has(githubAuthMode)) {
    return emptyResult(
      githubAuthMode,
      runtimeMode,
      FAILURE_INVALID_MODE,
      `unknown github_auth_mode ${pyRepr(githubAuthMode)}; expected one of ${pyRepr([...KNOWN_GITHUB_AUTH_MODES].sort())}`,
    );
  }

  const shared: GithubAuthValidationOptions = {
    repo: options.repo,
    runtimeMode,
    runGh: options.runGh,
    expectedPrincipal: options.expectedPrincipal,
    gitRemoteUrl: options.gitRemoteUrl,
    readGitRemote: options.readGitRemote,
    cwd: options.cwd,
  };

  if (githubAuthMode === GITHUB_AUTH_MODE_INJECTED_TOKEN) {
    return validateInjectedTokenMode(env, shared);
  }
  return validateHostGhMode(env, shared);
}

export function validateGithubAuthForWorker(
  githubAuthMode: string | null = null,
  options: {
    environ?: NodeJS.ProcessEnv;
    runtimeReport?: RuntimeCapabilityReport | null;
    repo?: string;
    runGh?: GhRunner;
    expectedPrincipal?: ExpectedGithubWorkerPrincipal | null;
    gitRemoteUrl?: string | null;
    readGitRemote?: GitRemoteReader;
    cwd?: string;
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
    principal_kind: result.principal?.kind ?? null,
    validation_repo: result.validationRepo,
  };
}

export interface GitHubAuthModesCliArgs {
  githubAuthMode?: string | null;
  repo?: string;
  json?: boolean;
  runGh?: GhRunner;
  expectedLogin?: string;
  expectedPrincipal?: ExpectedGithubWorkerPrincipal | null;
}

function expectedPrincipalFromCliArgs(
  args: GitHubAuthModesCliArgs,
): ExpectedGithubWorkerPrincipal | { error: string } | undefined {
  if (args.expectedPrincipal !== undefined) {
    return args.expectedPrincipal ?? undefined;
  }
  const login = args.expectedLogin?.trim() ?? "";
  if (login.length > 0) {
    return { kind: PRINCIPAL_KIND_USER, login };
  }
  return undefined;
}

export function githubAuthModesMain(args: GitHubAuthModesCliArgs): number {
  const fromFlags = expectedPrincipalFromCliArgs(args);
  if (fromFlags !== undefined && "error" in fromFlags) {
    process.stderr.write(`${fromFlags.error}\n`);
    return 2;
  }
  const result = validateGithubAuthForWorker(args.githubAuthMode ?? null, {
    repo: args.repo,
    runGh: args.runGh,
    expectedPrincipal: fromFlags,
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
