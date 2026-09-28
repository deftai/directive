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
 * is opt-in via `depth: "deep"` (session:start --with-network, `scm:status
 * --deep`). `requireScmReady` on `scm issue *`, `issue:ingest`, and
 * `reconcile:issues` requests deep for the #3858 credential-class ban.
 */

import {
  type ExpectedGithubWorkerPrincipal,
  FAILURE_MISSING_INJECTED_TOKEN,
  findApplicableInjectedToken,
  findInjectedToken,
  type GhRunner,
  GITHUB_AUTH_MODE_HOST_GH,
  GITHUB_AUTH_MODE_INJECTED_TOKEN,
  type GitHubAuthValidationResult,
  hostStoreIdentityFingerprint,
  inferGithubAuthMode,
  resolveGithubHost,
  tokenPresenceFingerprint,
  validateGithubAuthForWorker,
} from "../intake/github-auth-modes.js";
import {
  getPlatformCapabilities,
  probeRuntimeCapabilities,
  type RuntimeCapabilityReport,
} from "../intake/platform-capabilities.js";
import {
  GITHUB_AUTH_MODE_ENV,
  RUNTIME_REASON_CURSOR_MARKER_AMBIGUOUS,
} from "../platform/cursor-managed-runtime.js";
import {
  FAILURE_AMBIENT_TOKEN_CONFLICT,
  FAILURE_DELIVERY_MISMATCH,
  FAILURE_MISSING_DELIVERY,
  observedCredentialDeliveryId,
  type ReadWorkerAuthAssignmentResult,
  readWorkerAuthAssignment,
  type WorkerAuthAssignment,
} from "../swarm/worker-auth-assignment.js";
import { defaultWhich, spawnScmBinary, type WhichFn } from "./binary.js";
import { BINARY_PREFERENCE } from "./constants.js";
import { ScmStubError } from "./errors.js";

/**
 * Diagnostic skip-list of surfaces that will not work when SCM is not ready
 * (#2275). This is not the set of verbs the #3858 credential-class ban
 * authorizes (`scm issue *`, `issue:ingest`, `reconcile:issues`).
 */
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
  /** Stable id naming why the runtime was classified that way (#3859). */
  readonly runtimeModeReason: string | null;
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
  readonly host?: string | null;
  readonly expectedPrincipal?: ExpectedGithubWorkerPrincipal | null;
  readonly runGh?: GhRunner;
  /** When false, skip even `gh auth status` on the shallow path (tests / pure PATH). */
  readonly checkAuthStatus?: boolean;
  /**
   * Caller skip for unregistered destinations only (#3663). Registered workers
   * still validate after assignment resolution.
   */
  readonly skipReadiness?: boolean;
  /** Worktree used to resolve the worker-auth assignment. Defaults to cwd. */
  readonly cwd?: string;
  /** Test seam for assignment lookup. */
  readonly readWorkerAuthAssignment?: (cwd: string) => ReadWorkerAuthAssignmentResult;
}

const REMEDIATION_BINARY_ABSENT =
  "Remediation for missing gh/ghx in this execution env:\n" +
  "  - Install GitHub CLI in the *execution* environment (https://cli.github.com/)\n" +
  "  - Or install ghx (`task setup:ghx` / directive setup:ghx) then ensure PATH is updated\n" +
  "  - Or run SCM-dependent gates from a matched env where gh is already installed\n" +
  "  - Framework-local gates (session:start, verify:*, xbrief:preflight, doctor, scope:*) do not need SCM";

const REMEDIATION_MISSING_TOKEN =
  "Remediation for missing injected token (assigned injected-token or applicable token mode):\n" +
  "  - Pass the host-family token into the execution env (github.com/ghe.com: GH_TOKEN then GITHUB_TOKEN; GHES: GH_ENTERPRISE_TOKEN then GITHUB_ENTERPRISE_TOKEN)\n" +
  "  - Keep token values out of prompts and transcripts; inject via host secrets only\n" +
  "  - Unassigned sessions without an applicable token use the host gh store";

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

function mapDeepFailureToAuthState(result: GitHubAuthValidationResult): ScmAuthState {
  if (result.ok) return "authenticated";
  if (result.failureKind === "missing_injected_token") return "missing-token";
  if (result.failureKind === "gh_auth_failed") return "unauthenticated";
  if (
    result.failureKind === "api_unreachable" ||
    result.failureKind === "repo_access_denied" ||
    result.failureKind === "missing_expected_principal" ||
    result.failureKind === "principal_mismatch" ||
    result.failureKind === "missing_target_repo" ||
    result.failureKind === "installation_identity_unverifiable"
  ) {
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
  const githubHost = resolveGithubHost({
    host: options.host,
    environ: env,
    cwd: options.cwd,
  });
  const githubAuthMode = options.githubAuthMode ?? inferGithubAuthMode(env, { host: githubHost });
  const injectedTokenPresent = findApplicableInjectedToken(env, githubHost) !== null;
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
      runtimeModeReason: runtimeReport.runtimeModeReason ?? null,
      injectedTokenPresent,
      depth,
      detail,
      remediation: REMEDIATION_BINARY_ABSENT,
      skippedGates: [...SCM_DEPENDENT_GATES],
      login: null,
      failureKind: "binary_absent",
    };
  }

  // Injected-token mode without an applicable token is not-ready before API probes.
  if (githubAuthMode === GITHUB_AUTH_MODE_INJECTED_TOKEN && !injectedTokenPresent) {
    const detail =
      "injected-token mode requires an applicable token for the target GitHub host; " +
      `binary=${binary} present but SCM-dependent gates skipped ` +
      `(runtime_mode=${runtimeReport.runtimeMode}` +
      `${runtimeReport.runtimeModeReason ? `, reason=${runtimeReport.runtimeModeReason}` : ""}` +
      `, host=${githubHost})`;
    return {
      ready: false,
      binary,
      binaryPath,
      authState: "missing-token",
      githubAuthMode,
      runtimeMode: runtimeReport.runtimeMode,
      runtimeModeReason: runtimeReport.runtimeModeReason ?? null,
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
    // Prefer live `gh` for auth/API validation — ghx is a cached GET proxy and
    // rejects multi-arg api forms used by github-auth-modes (#2275 / #954).
    const deepRunner =
      options.runGh ??
      ((args, environ) => {
        const ghPath = whichFn("gh") ?? binary ?? "gh";
        try {
          const result = spawnScmBinary(ghPath, [...args], {
            env: environ,
            encoding: "utf8",
            timeout: 30_000,
            stdio: ["ignore", "pipe", "pipe"],
          });
          return {
            args: [ghPath, ...args],
            returncode: result.status ?? 1,
            stdout: typeof result.stdout === "string" ? result.stdout : "",
            stderr: typeof result.stderr === "string" ? result.stderr : "",
          };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return { args: [ghPath, ...args], returncode: 1, stdout: "", stderr: message };
        }
      });
    const deep = validateGithubAuthForWorker(githubAuthMode, {
      environ: env,
      runtimeReport,
      repo: options.repo,
      host: githubHost,
      expectedPrincipal: options.expectedPrincipal,
      runGh: deepRunner,
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
        runtimeModeReason: runtimeReport.runtimeModeReason ?? null,
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
      runtimeModeReason: runtimeReport.runtimeModeReason ?? null,
      injectedTokenPresent,
      depth,
      detail: `SCM not ready: ${deep.detail}`,
      remediation: deep.remediation ?? REMEDIATION_UNAUTHENTICATED,
      skippedGates: [...SCM_DEPENDENT_GATES],
      login: deep.login,
      failureKind: deep.failureKind,
    };
  }

  // Shallow path: binary + applicable-token presence. Aggregate `gh auth status`
  // (including hostname-only listings of inactive accounts) does not veto a
  // working effective credential. Deep admission uses selected-credential APIs.
  // authState stays unknown until a deep selected-credential API result.
  const checkAuth = options.checkAuthStatus !== false;
  const detail = checkAuth
    ? `SCM ready: ${binary} present, ${githubAuthMode} provisioned for ${githubHost} (shallow)`
    : `SCM binary present (${binary}); auth status not checked (shallow, checkAuthStatus=false); ` +
      `github_auth_mode=${githubAuthMode}`;
  return {
    ready: true,
    binary,
    binaryPath,
    authState: "unknown",
    githubAuthMode,
    runtimeMode: runtimeReport.runtimeMode,
    runtimeModeReason: runtimeReport.runtimeModeReason ?? null,
    injectedTokenPresent,
    depth,
    detail,
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
    runtime_mode_reason: report.runtimeModeReason,
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
    // Name the classification reason next to the skip: a silent skip is what
    // makes this failure costly, because work-selection surfaces go dark (#3859).
    const reason = report.runtimeModeReason ? ` (reason: ${report.runtimeModeReason})` : "";
    lines.push(`[deft scm] skipped gates: ${report.skippedGates.join(", ")}${reason}`);
    if (report.runtimeModeReason === RUNTIME_REASON_CURSOR_MARKER_AMBIGUOUS) {
      lines.push(
        "[deft scm] runtime classification is diagnostic only; credential admission uses " +
          "the provisioned source for the target host plus any explicit worker assignment (#5016)",
      );
    }
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
 * Fail-loud gate for `scm issue *`, `issue:ingest`, and `reconcile:issues`
 * (#2275 / #3858). Throws ScmStubError when binary is absent or auth is not
 * ready so agents never fall through into opaque gh spawn/auth-prompt failures.
 *
 * Those three callers request `depth: "deep"` so `validateGithubAuthForWorker`
 * runs the installation-class `/user` check. Cost: two extra REST calls and
 * up to 60 s added worst-case latency per gated process. Transient API
 * failure refuses the verb (same posture as #3422). This is a credential-class
 * ban: any user-bearing login is acceptable when no expected principal is
 * supplied. The repo GET does not authorize the operation.
 *
 * Process-scoped cache: keyed by repo + expected principal + credential
 * identity (injected-token fingerprint and host-store hosts.yml digest) so
 * alternating `--repo` checks do not evict each other and a host-store user
 * change revalidates. A cached shallow-ready report does not satisfy a later
 * principal/deep request for that same key. Pass `force: true` to re-probe
 * (tests / after credential injection).
 */
const cachedReadyReports = new Map<string, ScmReadinessReport>();

function readyCacheIdentity(options: ProbeScmReadinessOptions & { force?: boolean }): {
  repo: string;
  principal: string;
  host: string;
  mode: string;
  tokens: string;
  store: string;
} {
  const env = options.env ?? process.env;
  const host = resolveGithubHost({ host: options.host, environ: env, cwd: options.cwd });
  const mode = options.githubAuthMode ?? inferGithubAuthMode(env, { host });
  return {
    repo: options.repo ?? env.GH_REPO ?? env.GITHUB_REPOSITORY ?? "",
    principal: options.expectedPrincipal?.login ?? "",
    host,
    mode,
    tokens: tokenPresenceFingerprint(env, host),
    store: hostStoreIdentityFingerprint(env, host),
  };
}

function readyCacheKey(identity: {
  repo: string;
  principal: string;
  host: string;
  mode: string;
  tokens: string;
  store: string;
}): string {
  return `${identity.repo}\0${identity.principal}\0${identity.host}\0${identity.mode}\0${identity.tokens}\0${identity.store}`;
}

function cachedReportCoversRequestedDepth(
  cached: ScmReadinessReport,
  requestedDepth: ScmProbeDepth,
): boolean {
  if (requestedDepth === "deep") {
    return cached.depth === "deep";
  }
  return true;
}

function formatWorkerAuthDetail(
  failureKind: string,
  message: string,
  extras: {
    dispatchId?: string | null;
    expectedLogin?: string | null;
    observedLogin?: string | null;
  },
): string {
  const parts = [`worker auth failed: ${failureKind}: ${message}`];
  if (extras.dispatchId) {
    parts.push(`dispatch_id=${extras.dispatchId}`);
  }
  if (extras.expectedLogin) {
    parts.push(`expected_login=${extras.expectedLogin}`);
  }
  if (extras.observedLogin) {
    parts.push(`observed_login=${extras.observedLogin}`);
  }
  return parts.join(" ");
}

function workerAuthNotReady(
  failureKind: string,
  detail: string,
  extras: {
    githubAuthMode?: string;
    runtimeReport?: RuntimeCapabilityReport;
    binary?: ScmBinaryName | null;
    binaryPath?: string | null;
    login?: string | null;
    injectedTokenPresent?: boolean;
  } = {},
): ScmReadinessReport {
  const runtimeReport = extras.runtimeReport ?? getPlatformCapabilities();
  return {
    ready: false,
    binary: extras.binary ?? null,
    binaryPath: extras.binaryPath ?? null,
    authState: "unauthenticated",
    githubAuthMode: extras.githubAuthMode ?? GITHUB_AUTH_MODE_HOST_GH,
    runtimeMode: runtimeReport.runtimeMode,
    runtimeModeReason: runtimeReport.runtimeModeReason ?? null,
    injectedTokenPresent: extras.injectedTokenPresent ?? false,
    depth: "deep",
    detail,
    remediation: REMEDIATION_UNAUTHENTICATED,
    skippedGates: [...SCM_DEPENDENT_GATES],
    login: extras.login ?? null,
    failureKind,
  };
}

function classificationEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  delete copy[GITHUB_AUTH_MODE_ENV];
  return copy;
}

function unregisteredSkipReport(options: ProbeScmReadinessOptions): ScmReadinessReport {
  const hermeticRuntime = options.runtimeReport ?? getPlatformCapabilities();
  const env = options.env ?? process.env;
  const host = resolveGithubHost({
    host: options.host,
    environ: env,
    cwd: options.cwd,
    gitRemoteUrl: null,
  });
  return {
    ready: true,
    binary: "gh",
    binaryPath: null,
    authState: "unknown",
    githubAuthMode: GITHUB_AUTH_MODE_HOST_GH,
    runtimeMode: hermeticRuntime.runtimeMode,
    runtimeModeReason: hermeticRuntime.runtimeModeReason ?? null,
    injectedTokenPresent: findApplicableInjectedToken(env, host) !== null,
    depth: "shallow",
    detail: "SCM readiness skipped for unregistered destination",
    remediation: null,
    skippedGates: [],
    login: null,
    failureKind: null,
  };
}

function enforceRegisteredWorker(
  assignment: WorkerAuthAssignment,
  options: ProbeScmReadinessOptions,
): ScmReadinessReport {
  const env = options.env ?? process.env;
  const classified = probeRuntimeCapabilities(classificationEnv(env));
  const githubHost = resolveGithubHost({
    host: options.host,
    environ: env,
    cwd: options.cwd,
  });
  const injectedPresent = findApplicableInjectedToken(env, githubHost) !== null;
  const expectedLogin = assignment.expected_principal.login;
  const dispatchId = assignment.dispatch_id;
  const whichFn = options.whichFn ?? defaultWhich;
  const { binary, binaryPath } = resolveBinaryPresence(whichFn);

  const deny = (kind: string, message: string, observed?: string | null): ScmReadinessReport =>
    workerAuthNotReady(
      kind,
      formatWorkerAuthDetail(kind, message, {
        dispatchId,
        expectedLogin,
        observedLogin: observed ?? null,
      }),
      {
        githubAuthMode: assignment.github_auth_mode,
        runtimeReport: classified,
        binary,
        binaryPath,
        login: observed ?? null,
        injectedTokenPresent: injectedPresent,
      },
    );

  if (assignment.github_auth_mode === GITHUB_AUTH_MODE_HOST_GH) {
    if (injectedPresent) {
      return deny(
        FAILURE_AMBIENT_TOKEN_CONFLICT,
        "assigned host-gh refuses an applicable ambient token override for the target host even when it names the expected user",
      );
    }
  } else {
    // Non-secret PREP correlation id (UUID). Not a GitHub credential.
    const expectedDelivery = assignment.credential_delivery_id;
    const observedDelivery = observedCredentialDeliveryId(env);
    if (expectedDelivery === null || expectedDelivery.length === 0) {
      return deny(
        FAILURE_MISSING_DELIVERY,
        "injected-token assignment is missing credential_delivery_id",
      );
    }
    if (observedDelivery === null) {
      return deny(
        FAILURE_MISSING_DELIVERY,
        "worker env is missing DEFT_WORKER_CREDENTIAL_DELIVERY_ID",
      );
    }
    if (observedDelivery !== expectedDelivery) {
      return deny(
        FAILURE_DELIVERY_MISMATCH,
        "credential_delivery_id does not match the assignment",
      );
    }
    if (!injectedPresent) {
      return deny(
        FAILURE_MISSING_INJECTED_TOKEN,
        "injected-token assignment requires a worker token",
      );
    }
  }

  return probeScmReadiness({
    ...options,
    env,
    host: githubHost,
    runtimeReport: classified,
    githubAuthMode: assignment.github_auth_mode,
    expectedPrincipal: assignment.expected_principal,
    depth: "deep",
    checkAuthStatus: true,
  });
}

export function requireScmReady(
  options: ProbeScmReadinessOptions & { force?: boolean } = {},
): ScmReadinessReport {
  const cwd = options.cwd ?? process.cwd();
  const reader = options.readWorkerAuthAssignment ?? readWorkerAuthAssignment;
  const read = reader(cwd);
  let report: ScmReadinessReport;
  if (!read.ok) {
    report = workerAuthNotReady(
      read.failureKind,
      formatWorkerAuthDetail(read.failureKind, read.detail, read),
      { login: read.observedLogin },
    );
  } else if (read.assignment !== null) {
    report = enforceRegisteredWorker(read.assignment, options);
    if (report.ready) {
      return report;
    }
  } else if (options.skipReadiness === true) {
    return unregisteredSkipReport(options);
  } else {
    const requestedDepth: ScmProbeDepth = options.depth ?? "shallow";
    const identity = readyCacheIdentity(options);
    const cacheKey = readyCacheKey(identity);
    const cached = cachedReadyReports.get(cacheKey);
    if (
      !options.force &&
      cached !== undefined &&
      cachedReportCoversRequestedDepth(cached, requestedDepth)
    ) {
      return cached;
    }
    // Hermetic unit tests (VITEST) only require binary presence so CI
    // cloud-headless without injected tokens can exercise CLI argv/REST seams.
    // DEFT_SCM_SKIP_AUTH_PROBE does not skip production probes.
    // Registered workers above never take this branch (#3663).
    const hermeticAuthSkip = options.checkAuthStatus === undefined && process.env.VITEST === "true";
    if (hermeticAuthSkip) {
      const binary = assertScmBinaryPresent(options.whichFn);
      const hermeticRuntime = options.runtimeReport ?? getPlatformCapabilities();
      const hermetic: ScmReadinessReport = {
        ready: true,
        binary,
        binaryPath: options.whichFn?.(binary) ?? null,
        authState: "unknown",
        githubAuthMode: GITHUB_AUTH_MODE_HOST_GH,
        runtimeMode: hermeticRuntime.runtimeMode,
        runtimeModeReason: hermeticRuntime.runtimeModeReason ?? null,
        injectedTokenPresent:
          findApplicableInjectedToken(
            options.env ?? process.env,
            resolveGithubHost({
              host: options.host,
              environ: options.env ?? process.env,
              cwd: options.cwd,
              gitRemoteUrl: null,
            }),
          ) !== null,
        depth: "shallow",
        detail: `SCM binary present (${binary}); auth status not checked (hermetic)`,
        remediation: null,
        skippedGates: [],
        login: null,
        failureKind: null,
      };
      cachedReadyReports.set(cacheKey, hermetic);
      return hermetic;
    }
    report = probeScmReadiness({
      ...options,
      depth: options.depth ?? "shallow",
      checkAuthStatus: options.checkAuthStatus ?? true,
    });
    if (report.ready) {
      cachedReadyReports.set(cacheKey, report);
      return report;
    }
  }
  throw scmNotReadyError(report);
}

/**
 * Clear the process-scoped readiness cache.
 * Used by tests and by long-running processes after credential injection.
 */
export function clearScmReadyCache(): void {
  cachedReadyReports.clear();
}

export { findInjectedToken, GITHUB_AUTH_MODE_HOST_GH, GITHUB_AUTH_MODE_INJECTED_TOKEN };
