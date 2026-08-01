/**
 * SCM tooling + auth readiness probe for mismatched / headless envs (#2275).
 *
 * Framework-local gates (session:start, verify:*, xbrief:preflight, doctor,
 * scope:*) run without GitHub credentials. SCM-dependent gates (triage:queue,
 * issue:ingest, pr:*, reconcile:issues, cache:fetch-all, scm:*) need `gh`/`ghx`
 * on PATH and either host credential store auth or an injected token
 * (`GH_TOKEN` / `GITHUB_TOKEN` / `GH_ENTERPRISE_TOKEN`).
 *
 * This module:
 *   1. Detects binary + auth state in the *current* execution env (not the
 *      install host).
 *   2. Emits a clear one-line diagnostic for session-start and CLI surfaces.
 *   3. Lists which SCM-dependent gates are skipped when readiness is false.
 *   4. Supplies fail-loud error text so SCM verbs never fail opaquely.
 *
 * Hot-path rule (#2991): the default "shallow" probe is local-only (PATH +
 * env token presence + optional short `gh auth status`). Deep API validation
 * is opt-in via `deep: true` (session:start --with-network).
 */

import { spawnSync } from "node:child_process";
import {
  findInjectedToken,
  type GhRunner,
  GITHUB_AUTH_MODE_HOST_GH,
  GITHUB_AUTH_MODE_INJECTED_TOKEN,
  type GitHubAuthValidationResult,
  inferGithubAuthMode,
  validateGithubAuthForWorker,
} from "../intake/github-auth-modes.js";
import {
  getPlatformCapabilities,
  probeRuntimeCapabilities,
  type RuntimeCapabilityReport,
} from "../intake/platform-capabilities.js";
import { defaultWhich, type WhichFn } from "./binary.js";
import type { CompletedProcess } from "./call.js";
import { BINARY_PREFERENCE } from "./constants.js";
import { ScmStubError } from "./errors.js";

/** Named SCM-dependent surfaces that need gh/ghx + auth (#2275). */
export const SCM_DEPENDENT_GATES = [
  "triage:queue",
  "triage:welcome (network hydrate)",
  "issue:ingest",
  "reconcile:issues",
  "pr:*",
  "cache:fetch-all",
  "scm:*",
  "github-auth-modes (deep)",
  "umbrella:current-shape",
] as const;

export type ScmBinaryName = (typeof BINARY_PREFERENCE)[number];

export type ScmAuthState =
  | "authenticated"
  | "unauthenticated"
  | "missing-token"
  | "binary-absent"
  | "unknown";

export type ScmProbeDepth = "shallow" | "deep";

export interface ScmReadinessReport {
  /** True when a binary is on PATH and auth is usable for SCM gates. */
  readonly ready: boolean;
  /** Preferred binary name when present (`ghx` > `gh`). */
  readonly binary: ScmBinaryName | null;
  /** Absolute path from PATH lookup, when known. */
  readonly binaryPath: string | null;
  /** Auth usability classification. */
  readonly authState: ScmAuthState;
  /** Inferred or explicit github_auth_mode label (never a secret). */
  readonly githubAuthMode: string;
  /** Runtime mode from the #1557a probe. */
  readonly runtimeMode: string;
  /** Whether an injected token env var is present (value never reported). */
  readonly injectedTokenPresent: boolean;
  /** Probe depth used for this report. */
  readonly depth: ScmProbeDepth;
  /** One-line human diagnostic (no secrets). */
  readonly detail: string;
  /** Multi-line remediation when not ready; null when ready. */
  readonly remediation: string | null;
  /** Named SCM-dependent gates skipped when not ready (empty when ready). */
  readonly skippedGates: readonly string[];
  /** Login from deep validation when available. */
  readonly login: string | null;
  /** failure_kind from deep validation when applicable. */
  readonly failureKind: string | null;
}

export interface ProbeScmReadinessOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly whichFn?: WhichFn;
  /** `shallow` (default) = PATH + token + optional auth status; `deep` = full auth validation. */
  readonly depth?: ScmProbeDepth;
  readonly runtimeReport?: RuntimeCapabilityReport;
  readonly githubAuthMode?: string | null;
  readonly repo?: string;
  readonly runGh?: GhRunner;
  /** When false, skip even `gh auth status` on the shallow path (tests / pure PATH). */
  readonly checkAuthStatus?: boolean;
}

const REMEDIATION_BINARY_ABSENT =
  "Remediation for missing gh/ghx in this execution env:\n" +
  "  - Install GitHub CLI in the *execution* environment (https://cli.github.com/)\n" +
  "  - Or install ghx (`task setup:ghx` / directive setup:ghx) then ensure PATH is updated\n" +
  "  - Or run SCM-dependent gates from a matched env where gh is already installed\n" +
  "  - Framework-local gates (session:start, verify:*, xbrief:preflight, doctor, scope:*) do not need SCM";

const REMEDIATION_MISSING_TOKEN =
  "Remediation for missing injected token (cloud/headless auth mode):\n" +
  "  - Pass GH_TOKEN, GITHUB_TOKEN, or GH_ENTERPRISE_TOKEN into the execution env\n" +
  "  - Keep token values out of prompts and transcripts; inject via host secrets only\n" +
  "  - Or run SCM-dependent gates from a matched host-gh env instead";

const REMEDIATION_UNAUTHENTICATED =
  "Remediation for unauthenticated gh in this execution env:\n" +
  "  - host-gh: run `gh auth login` in this env (host credential store is not shared with sandboxes)\n" +
  "  - injected-token: set GH_TOKEN / GITHUB_TOKEN / GH_ENTERPRISE_TOKEN and re-probe\n" +
  "  - Or run SCM-dependent gates from the matched/authenticated env\n" +
  "  - See content/scm/github.md § Mismatched/headless SCM readiness (#2275)";

function resolveBinaryPresence(whichFn: WhichFn): {
  binary: ScmBinaryName | null;
  binaryPath: string | null;
} {
  for (const candidate of BINARY_PREFERENCE) {
    const path = whichFn(candidate);
    if (path !== null) {
      return { binary: candidate, binaryPath: path };
    }
  }
  return { binary: null, binaryPath: null };
}

/**
 * Run gh/ghx argv directly (not via scm.call) so readiness probing never
 * re-enters call() / readiness and cannot mis-route `auth status` (#2275 P1).
 */
function defaultShallowRunGh(
  args: readonly string[],
  environ: NodeJS.ProcessEnv,
  whichFn: WhichFn = defaultWhich,
): CompletedProcess {
  const { binary } = resolveBinaryPresence(whichFn);
  const resolved = binary ?? "gh";
  try {
    const result = spawnSync(resolved, [...args], {
      env: environ,
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      args: [resolved, ...args],
      returncode: result.status ?? 1,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      args: [resolved, ...args],
      returncode: 1,
      stdout: "",
      stderr: message,
    };
  }
}

function mapDeepFailureToAuthState(result: GitHubAuthValidationResult): ScmAuthState {
  if (result.ok) return "authenticated";
  if (result.failureKind === "missing_injected_token") return "missing-token";
  if (result.failureKind === "gh_auth_failed") return "unauthenticated";
  if (result.failureKind === "api_unreachable" || result.failureKind === "repo_access_denied") {
    return "unauthenticated";
  }
  return "unknown";
}

/**
 * Probe SCM binary + auth readiness in the current execution environment.
 *
 * Never throws. Never echoes token values. Suitable for session:start.
 */
export function probeScmReadiness(options: ProbeScmReadinessOptions = {}): ScmReadinessReport {
  const env = options.env ?? process.env;
  const whichFn = options.whichFn ?? defaultWhich;
  const depth: ScmProbeDepth = options.depth ?? "shallow";
  const runtimeReport = options.runtimeReport ?? probeRuntimeCapabilities(env);
  const githubAuthMode = options.githubAuthMode ?? inferGithubAuthMode(runtimeReport);
  const injectedTokenPresent = findInjectedToken(env) !== null;
  const { binary, binaryPath } = resolveBinaryPresence(whichFn);

  if (binary === null) {
    const detail =
      "gh not found on PATH in this execution env; SCM-dependent gates skipped " +
      `(runtime_mode=${runtimeReport.runtimeMode}, github_auth_mode=${githubAuthMode})`;
    return {
      ready: false,
      binary: null,
      binaryPath: null,
      authState: "binary-absent",
      githubAuthMode,
      runtimeMode: runtimeReport.runtimeMode,
      injectedTokenPresent,
      depth,
      detail,
      remediation: REMEDIATION_BINARY_ABSENT,
      skippedGates: [...SCM_DEPENDENT_GATES],
      login: null,
      failureKind: "binary_absent",
    };
  }

  // Injected-token mode without a token is a hard not-ready even before auth status.
  if (githubAuthMode === GITHUB_AUTH_MODE_INJECTED_TOKEN && !injectedTokenPresent) {
    const detail =
      "injected-token mode requires GH_TOKEN, GITHUB_TOKEN, or GH_ENTERPRISE_TOKEN; " +
      `binary=${binary} present but SCM-dependent gates skipped ` +
      `(runtime_mode=${runtimeReport.runtimeMode})`;
    return {
      ready: false,
      binary,
      binaryPath,
      authState: "missing-token",
      githubAuthMode,
      runtimeMode: runtimeReport.runtimeMode,
      injectedTokenPresent: false,
      depth,
      detail,
      remediation: REMEDIATION_MISSING_TOKEN,
      skippedGates: [...SCM_DEPENDENT_GATES],
      login: null,
      failureKind: "missing_injected_token",
    };
  }

  if (depth === "deep") {
    const deep = validateGithubAuthForWorker(githubAuthMode, {
      environ: env,
      runtimeReport,
      repo: options.repo,
      runGh: options.runGh,
    });
    if (deep.ok) {
      const loginPart = deep.login ? ` as ${deep.login}` : "";
      return {
        ready: true,
        binary,
        binaryPath,
        authState: "authenticated",
        githubAuthMode: deep.githubAuthMode,
        runtimeMode: runtimeReport.runtimeMode,
        injectedTokenPresent,
        depth,
        detail: `SCM ready: ${binary} present, ${deep.githubAuthMode} authenticated${loginPart} (deep)`,
        remediation: null,
        skippedGates: [],
        login: deep.login,
        failureKind: null,
      };
    }
    const authState = mapDeepFailureToAuthState(deep);
    return {
      ready: false,
      binary,
      binaryPath,
      authState,
      githubAuthMode: deep.githubAuthMode,
      runtimeMode: runtimeReport.runtimeMode,
      injectedTokenPresent,
      depth,
      detail: `SCM not ready: ${deep.detail}`,
      remediation: deep.remediation ?? REMEDIATION_UNAUTHENTICATED,
      skippedGates: [...SCM_DEPENDENT_GATES],
      login: deep.login,
      failureKind: deep.failureKind,
    };
  }

  // Shallow path: optional gh auth status (local credential check, short timeout).
  const checkAuth = options.checkAuthStatus !== false;
  if (!checkAuth) {
    const detail =
      `SCM binary present (${binary}); auth status not checked (shallow, checkAuthStatus=false); ` +
      `github_auth_mode=${githubAuthMode}`;
    return {
      ready: true,
      binary,
      binaryPath,
      authState: "unknown",
      githubAuthMode,
      runtimeMode: runtimeReport.runtimeMode,
      injectedTokenPresent,
      depth,
      detail,
      remediation: null,
      skippedGates: [],
      login: null,
      failureKind: null,
    };
  }

  const runner = options.runGh ?? ((args, environ) => defaultShallowRunGh(args, environ, whichFn));
  const authStatus = runner(["auth", "status"], env);
  if (authStatus.returncode !== 0) {
    const detail =
      `gh not authenticated in this execution env (binary=${binary}, ` +
      `github_auth_mode=${githubAuthMode}); SCM-dependent gates skipped`;
    return {
      ready: false,
      binary,
      binaryPath,
      authState: "unauthenticated",
      githubAuthMode,
      runtimeMode: runtimeReport.runtimeMode,
      injectedTokenPresent,
      depth,
      detail,
      remediation: REMEDIATION_UNAUTHENTICATED,
      skippedGates: [...SCM_DEPENDENT_GATES],
      login: null,
      failureKind: "gh_auth_failed",
    };
  }

  return {
    ready: true,
    binary,
    binaryPath,
    authState: "authenticated",
    githubAuthMode,
    runtimeMode: runtimeReport.runtimeMode,
    injectedTokenPresent,
    depth,
    detail: `SCM ready: ${binary} present, ${githubAuthMode} authenticated (shallow)`,
    remediation: null,
    skippedGates: [],
    login: null,
    failureKind: null,
  };
}

/** JSON-friendly snake_case dict for session:start --json / CLI. */
export function scmReadinessToDict(report: ScmReadinessReport): Record<string, unknown> {
  return {
    ready: report.ready,
    binary: report.binary,
    binary_path: report.binaryPath,
    auth_state: report.authState,
    github_auth_mode: report.githubAuthMode,
    runtime_mode: report.runtimeMode,
    injected_token_present: report.injectedTokenPresent,
    depth: report.depth,
    detail: report.detail,
    remediation: report.remediation,
    skipped_gates: [...report.skippedGates],
    login: report.login,
    failure_kind: report.failureKind,
  };
}

/**
 * Format human lines for session:start (and similar orientation surfaces).
 * First line is always the one-line status; when not ready, adds skipped gates
 * and a short remediation pointer.
 */
export function formatScmReadinessLines(report: ScmReadinessReport): string[] {
  const lines: string[] = [];
  if (report.ready) {
    lines.push(`[deft scm] ${report.detail}`);
    return lines;
  }
  lines.push(`[deft scm] ${report.detail}`);
  if (report.skippedGates.length > 0) {
    lines.push(`[deft scm] skipped gates: ${report.skippedGates.join(", ")}`);
  }
  lines.push(
    "[deft scm] run SCM-dependent gates only after auth is ready, or from a matched env; " +
      "see content/scm/github.md § Mismatched/headless SCM readiness (#2275)",
  );
  return lines;
}

/**
 * Fail-loud error for SCM-dependent entry points when readiness is false.
 * Includes named reason + skipped-gate list so agents never see an opaque failure.
 */
export function scmNotReadyError(report?: ScmReadinessReport): ScmStubError {
  const r = report ?? probeScmReadiness({ checkAuthStatus: false });
  if (r.ready && r.binary !== null) {
    // Caller asked for an error but probe is ready — still surface binary guidance.
    return new ScmStubError(
      "SCM readiness unexpected: binary present but caller refused; " +
        "see content/scm/github.md § Mismatched/headless SCM readiness (#2275)",
    );
  }
  const gates = r.skippedGates.length > 0 ? ` skipped_gates=[${r.skippedGates.join(", ")}]` : "";
  return new ScmStubError(
    `${r.detail}.${gates} Remediation: install gh/ghx and authenticate in this execution env ` +
      `(host-gh: gh auth login; injected-token: GH_TOKEN/GITHUB_TOKEN), or run SCM gates from a matched env. ` +
      `Refs #2275.`,
  );
}

/**
 * Assert SCM binary presence for call sites that only need PATH resolution.
 * Throws ScmStubError with #2275 diagnostic (not the bare "neither ghx nor gh" text alone).
 */
export function assertScmBinaryPresent(whichFn: WhichFn = defaultWhich): ScmBinaryName {
  const report = probeScmReadiness({
    whichFn,
    checkAuthStatus: false,
    depth: "shallow",
    // Binary-only assert must not flip to missing-token just because runtime is headless.
    githubAuthMode: GITHUB_AUTH_MODE_HOST_GH,
    runtimeReport: getPlatformCapabilities(),
  });
  if (report.binary === null) {
    throw scmNotReadyError(report);
  }
  return report.binary;
}

/**
 * Fail-loud gate for SCM-dependent verbs (#2275).
 * Throws ScmStubError when binary is absent or auth is not ready so agents
 * never fall through into opaque gh spawn/auth-prompt failures.
 *
 * Process-scoped cache: the first successful probe is reused for the rest of
 * the process so hot call paths do not re-run `gh auth status` every time.
 * Pass `force: true` to re-probe (tests / after credential injection).
 */
let cachedReadyReport: ScmReadinessReport | null = null;

export function requireScmReady(
  options: ProbeScmReadinessOptions & { force?: boolean } = {},
): ScmReadinessReport {
  if (!options.force && cachedReadyReport !== null && cachedReadyReport.ready) {
    return cachedReadyReport;
  }
  // Hermetic unit tests (vitest) and DEFT_SCM_SKIP_AUTH_PROBE only require
  // binary presence so CI cloud-headless without injected tokens can exercise
  // CLI argv/REST seams. Production agents get full shallow auth probing.
  // Session-start / scm:status always report full auth state regardless.
  const hermeticAuthSkip =
    options.checkAuthStatus === undefined &&
    (process.env.VITEST === "true" || process.env.DEFT_SCM_SKIP_AUTH_PROBE === "1");
  const report = probeScmReadiness({
    ...options,
    depth: options.depth ?? "shallow",
    checkAuthStatus: options.checkAuthStatus ?? (hermeticAuthSkip ? false : true),
    // Binary gate under hermetic skip must not flip to missing-token solely
    // because CI sets cloud-headless / injected-token inference.
    githubAuthMode:
      options.githubAuthMode ?? (hermeticAuthSkip ? GITHUB_AUTH_MODE_HOST_GH : undefined),
  });
  if (!report.ready) {
    throw scmNotReadyError(report);
  }
  cachedReadyReport = report;
  return report;
}

/** Test helper: clear the process-scoped readiness cache. */
export function clearScmReadyCache(): void {
  cachedReadyReport = null;
}

export { findInjectedToken, GITHUB_AUTH_MODE_HOST_GH, GITHUB_AUTH_MODE_INJECTED_TOKEN };
