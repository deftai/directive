import { randomUUID } from "node:crypto";
import { runningInsideDeftRepo } from "../doctor/paths.js";
import { emitSessionEvalReadback } from "../eval/readback.js";
import { MIGRATE_COMPLETION_NUDGE, shouldEmitMigrateNudge } from "../init-deposit/migrate.js";
import {
  detectEnvironmentContext,
  type EnvironmentContext,
  environmentContextToDict,
  formatEnvironmentContext,
} from "../platform/shell-context.js";
import { disclosureLine } from "../policy/disclosure.js";
import {
  detectNoDeftDirective,
  NO_DEFT_DIRECTIVE_DISABLED_MESSAGE,
  NO_DEFT_DIRECTIVE_FLAG_NAME,
  NO_DEFT_DIRECTIVE_INCONSISTENT_MESSAGE,
  NO_DEFT_DIRECTIVE_INCONSISTENT_POLICY,
} from "../policy/no-deft-directive.js";
import {
  humanMergeDisclosureLine,
  resolveHumanMergePolicy,
} from "../policy/require-human-merge.js";
import { resolvePolicy } from "../policy/resolve.js";
import { maybeFormatProductSignalConsentPrompt } from "../product-signal/consent-prompt.js";
import { formatFrameworkCommand } from "../render/framework-commands.js";
import {
  formatScmReadinessLines,
  type ProbeScmReadinessOptions,
  probeScmReadiness,
  type ScmReadinessReport,
  scmReadinessToDict,
} from "../scm/readiness.js";
import { maybeRunStalenessTickler } from "../staleness-tickler/run.js";
import { runDefaultMode } from "../triage/welcome/default-mode.js";
import { type ResolveUserMdResult, resolveUserMdPath } from "../user-config/resolve-user-md.js";
import { emitSessionValueReadback } from "../value/readback.js";
import { verifyRequiredTools } from "../verify-env/verify-tools.js";
import type { GitRunner } from "./git.js";
import { defaultGitRunner, gitHead, gitIsAncestor, worktreePath } from "./git.js";
import { emitSessionStartProcessCost } from "./process-cost.js";
import {
  probeSessionReleaseAvailability,
  type ReleaseAvailabilityProbeOptions,
} from "./release-availability.js";
import {
  newRitualStatePayload,
  type RitualState,
  readRitualState,
  ritualStatePath,
  ritualStep,
  writeRitualState,
} from "./ritual-sentinel.js";

export const SESSION_POSTURES = ["read-only", "mutation"] as const;
export type SessionPosture = (typeof SESSION_POSTURES)[number];
export const READ_ONLY_POSTURE: SessionPosture = "read-only";
export const MUTATION_POSTURE: SessionPosture = "mutation";
export const READ_ONLY_ALIGNMENT_MESSAGE = "Deft Directive active -- AGENTS.md loaded.";
export const READ_ONLY_RESULT_MESSAGE =
  "read-only session posture (alignment only; no ritual-state write)";

/** Cold (full) vs re-arm (clock/HEAD refresh) ceremony tiers (#2992). */
export const SESSION_CEREMONY_TIERS = ["cold", "rearm"] as const;
export type SessionCeremonyTier = (typeof SESSION_CEREMONY_TIERS)[number];
export const COLD_CEREMONY_TIER: SessionCeremonyTier = "cold";
export const REARM_CEREMONY_TIER: SessionCeremonyTier = "rearm";

export const QUICK_STEPS = ["alignment", "branch_policy", "triage_welcome"] as const;
export const GATED_STEPS = ["doctor", "cache_fresh"] as const;

/** Env opt-in for optional session:start network (release probe + triage cache hydrate) (#2991). */
export const ENV_SESSION_START_NETWORK = "DEFT_SESSION_START_NETWORK";

/** Human-readable skip notice when optional network is off the hot path (#2991). */
export const OPTIONAL_NETWORK_SKIPPED_MESSAGE =
  "[deft session] optional network skipped (release probe, triage cache hydrate/self-heal); " +
  "pass --with-network or set DEFT_SESSION_START_NETWORK=1 to enable.";

/** Re-arm skips fat cold-path work when prior ritual is still structurally valid (#2992). */
export const REARM_SKIPPED_FAT_PATH_MESSAGE =
  "[deft session] re-arm tier: refreshed ritual clock + HEAD/worktree bind; " +
  "skipped verify:tools, triage welcome, release probe, and staleness tickler.";

/** When --rearm is requested but state requires a full cold ceremony (#2992). */
export const REARM_INELIGIBLE_PREFIX = "session re-arm refused — full cold session:start required:";

export interface SessionStartStepTiming {
  readonly name: string;
  readonly duration_ms: number;
  readonly skipped?: boolean;
}

const STEP_ALIASES: Record<string, string> = {
  branch: "branch_policy",
  "branch-policy": "branch_policy",
  cache: "cache_fresh",
  "cache-fresh": "cache_fresh",
  triage: "triage_welcome",
  "triage-welcome": "triage_welcome",
};

export interface DefaultBranchSync {
  readonly branch: string | null;
  readonly upstream: string | null;
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly warning: string | null;
}

export interface SessionStartResult {
  readonly code: number;
  readonly payload: Record<string, unknown>;
  readonly lines: readonly string[];
}

export interface SessionStartOptions {
  /** #2176: read-only records alignment only; mutation runs the full quick tier. */
  readonly posture?: SessionPosture;
  /**
   * #2992: `rearm` refreshes ritual clock/HEAD/worktree without fat cold path
   * (no verify:tools, triage welcome, release probe, tickler). Default `cold`.
   * CLI: `--rearm` or `--tier=rearm`.
   */
  readonly ceremonyTier?: SessionCeremonyTier;
  readonly deferrals?: Readonly<Record<string, string>>;
  readonly now?: Date;
  readonly writeHistory?: boolean;
  readonly runGit?: GitRunner;
  readonly newSessionId?: () => string;
  readonly runTriageWelcome?: (
    projectRoot: string,
    options: { writeHistory: boolean; now: Date; output: (line: string) => void },
  ) => { exitCode: number };
  readonly verifyTools?: (output: (line: string) => void) => { exitCode: number };
  readonly resolveUserMd?: (projectRoot: string) => ResolveUserMdResult;
  readonly probeEnvironment?: () => EnvironmentContext;
  readonly probeReleaseAvailability?: (
    projectRoot: string,
    options: ReleaseAvailabilityProbeOptions,
  ) => { lines: readonly string[] };
  readonly runStalenessTickler?: (
    projectRoot: string,
    options: { now?: Date },
  ) => { lines: readonly string[]; prompted: boolean };
  /**
   * #2991: when true, run optional network (npm release probe + triage cache
   * empty-hydrate / self-heal) before ritual-state write. Default false so the
   * mutation hot path does not block on GitHub/npm. CLI: `--with-network`;
   * env: `DEFT_SESSION_START_NETWORK=1`.
   * Ignored on re-arm tier (always skips optional network).
   */
  readonly allowOptionalNetwork?: boolean;
  /** Process env for network opt-in resolution (tests inject). */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * #2275: SCM tooling + auth readiness probe for mismatched/headless envs.
   * Defaults to probeScmReadiness; shallow on hot path, deep when optional
   * network is enabled. Inject in tests.
   */
  readonly probeScm?: (options: ProbeScmReadinessOptions) => ScmReadinessReport;
}

/** Format preferred `session:start` recovery command for cold vs re-arm (#2992). */
export function formatSessionStartRecoveryCommand(tier: SessionCeremonyTier = "cold"): string {
  if (tier === "rearm") {
    return formatFrameworkCommand(["session:start", "--rearm"]);
  }
  return formatFrameworkCommand(["session:start"]);
}

function stepPassesForRearm(step: Record<string, unknown> | undefined): boolean {
  if (!step || typeof step !== "object") return false;
  if (step.deferred_reason) return true;
  return step.ok === true;
}

export type RearmEligibility =
  | {
      eligible: true;
      state: RitualState;
      currentHead: string;
      currentWorktree: string;
    }
  | { eligible: false; reason: string };

/**
 * Whether a prior ritual can be re-armed without a full cold ceremony (#2992).
 * Requires valid state, same worktree, continuous (or identical) HEAD, and
 * previously-passing quick steps.
 */
export function assessRearmEligibility(
  projectRoot: string,
  options: { runGit?: GitRunner } = {},
): RearmEligibility {
  const runGit = options.runGit ?? defaultGitRunner;
  const [state, err] = readRitualState(projectRoot);
  if (state === null) {
    return {
      eligible: false,
      reason: err ?? "ritual state missing (first install / cold path required)",
    };
  }
  const { head: currentHead, error: headError } = gitHead(projectRoot, runGit);
  if (currentHead === null) {
    return { eligible: false, reason: headError ?? "could not resolve git HEAD" };
  }
  const currentWorktree = worktreePath(projectRoot, runGit);
  if (state.worktreePath !== currentWorktree) {
    return {
      eligible: false,
      reason: `ritual state belongs to a different worktree (${state.worktreePath})`,
    };
  }
  if (state.gitHead !== currentHead) {
    const forward = gitIsAncestor(projectRoot, state.gitHead, currentHead, runGit);
    if (forward === null) {
      return { eligible: false, reason: "could not verify git history for session re-arm" };
    }
    if (!forward) {
      return {
        eligible: false,
        reason: "git HEAD changed discontinuously (full cold session:start required)",
      };
    }
  }
  for (const stepName of QUICK_STEPS) {
    if (!stepPassesForRearm(state.quickSteps[stepName])) {
      return {
        eligible: false,
        reason: `quick step '${stepName}' is missing or failed (full cold session:start required)`,
      };
    }
  }
  return { eligible: true, state, currentHead, currentWorktree };
}

function restampSteps(
  steps: Record<string, Record<string, unknown>>,
  now: Date,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, step] of Object.entries(steps)) {
    out[name] = {
      ...step,
      ts: ritualStep({ ok: step.ok === true, ts: now }).ts,
    };
  }
  return out;
}

/** Resolve whether optional session:start network work is enabled (#2991). */
export function resolveSessionStartOptionalNetwork(
  options: Pick<SessionStartOptions, "allowOptionalNetwork" | "env"> = {},
): boolean {
  if (options.allowOptionalNetwork === true) return true;
  if (options.allowOptionalNetwork === false) return false;
  const env = options.env ?? process.env;
  return env[ENV_SESSION_START_NETWORK] === "1";
}

function elapsedMs(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

function normaliseStepName(name: string): string {
  return STEP_ALIASES[name] ?? name;
}

export function parseDeferrals(rawValues: readonly string[]): {
  deferrals: Record<string, string>;
  errors: string[];
} {
  const allowed = new Set<string>([...QUICK_STEPS, ...GATED_STEPS]);
  const deferrals: Record<string, string> = {};
  const errors: string[] = [];
  for (const raw of rawValues) {
    const eq = raw.indexOf("=");
    if (eq < 0) {
      errors.push(`--defer expects step=reason, got ${JSON.stringify(raw)}`);
      continue;
    }
    const name = raw.slice(0, eq);
    const reason = raw.slice(eq + 1);
    const stepName = normaliseStepName(name.trim());
    if (!allowed.has(stepName)) {
      errors.push(
        `unknown ritual step ${JSON.stringify(name)}; expected one of ${JSON.stringify([...allowed].sort())}`,
      );
      continue;
    }
    if (reason.trim().length === 0) {
      errors.push(`--defer ${name}=... requires a non-empty reason`);
      continue;
    }
    deferrals[stepName] = reason.trim();
  }
  return { deferrals, errors };
}

function recordDeferredSteps(
  steps: readonly string[],
  deferrals: Readonly<Record<string, string>>,
  now: Date,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const name of steps) {
    const reason = deferrals[name];
    if (reason) {
      out[name] = ritualStep({ ok: true, ts: now, deferredReason: reason });
    }
  }
  return out;
}

function defaultBranchCandidates(projectRoot: string, runGit: GitRunner): string[] {
  const sym = runGit(projectRoot, ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]);
  if (sym.code === 0 && sym.stdout) {
    const parts = sym.stdout.split("/");
    return [(parts.slice(1).join("/") || parts[0]) ?? ""];
  }
  const candidates: string[] = [];
  for (const branch of ["main", "master"]) {
    const check = runGit(projectRoot, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${branch}`,
    ]);
    if (check.code === 0) {
      candidates.push(branch);
    }
  }
  return candidates;
}

export function defaultBranchSync(
  projectRoot: string,
  runGit: GitRunner = defaultGitRunner,
): DefaultBranchSync {
  const candidates = defaultBranchCandidates(projectRoot, runGit);
  if (candidates.length === 0) {
    return {
      branch: null,
      upstream: null,
      ahead: null,
      behind: null,
      warning: "[deft branch] Could not resolve a local default branch (`main` or `master`).",
    };
  }
  const branch = candidates[0] ?? null;
  if (!branch) {
    return {
      branch: null,
      upstream: null,
      ahead: null,
      behind: null,
      warning: "[deft branch] Could not resolve a local default branch (`main` or `master`).",
    };
  }
  const upstreamResult = runGit(projectRoot, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
  if (upstreamResult.code !== 0 || !upstreamResult.stdout) {
    return {
      branch,
      upstream: null,
      ahead: null,
      behind: null,
      warning: `[deft branch] Local ${branch} has no upstream tracking branch.`,
    };
  }
  const upstream = upstreamResult.stdout;
  const slash = upstream.indexOf("/");
  const remote = slash >= 0 ? upstream.slice(0, slash) : "origin";
  const remoteBranch = slash >= 0 ? upstream.slice(slash + 1) : upstream;
  const fetch = runGit(projectRoot, ["fetch", "--quiet", remote, remoteBranch]);
  if (fetch.code !== 0) {
    const detail = fetch.stderr || "remote refresh failed";
    return {
      branch,
      upstream,
      ahead: null,
      behind: null,
      warning: `[deft branch] Could not refresh ${upstream} for local ${branch}: ${detail}`,
    };
  }
  const counts = runGit(projectRoot, [
    "rev-list",
    "--left-right",
    "--count",
    `${branch}...${upstream}`,
  ]);
  if (counts.code !== 0 || !counts.stdout) {
    const detail = counts.stderr || "ahead/behind count failed";
    return {
      branch,
      upstream,
      ahead: null,
      behind: null,
      warning: `[deft branch] Could not compare local ${branch} with ${upstream}: ${detail}`,
    };
  }
  const parts = counts.stdout.trim().split(/\s+/);
  if (parts.length !== 2) {
    return {
      branch,
      upstream,
      ahead: null,
      behind: null,
      warning:
        `[deft branch] Could not parse branch sync counts for ${branch} ` +
        `and ${upstream}: ${counts.stdout}`,
    };
  }
  const ahead = Number.parseInt(parts[0] ?? "", 10);
  const behind = Number.parseInt(parts[1] ?? "", 10);
  if (Number.isNaN(ahead) || Number.isNaN(behind)) {
    return {
      branch,
      upstream,
      ahead: null,
      behind: null,
      warning:
        `[deft branch] Could not parse branch sync counts for ${branch} ` +
        `and ${upstream}: ${counts.stdout}`,
    };
  }
  if (ahead === 0 && behind === 0) {
    return { branch, upstream, ahead, behind, warning: null };
  }
  let warning: string;
  if (ahead > 0 && behind > 0) {
    warning =
      `[deft branch] Local ${branch} has diverged from ${upstream} ` +
      `(${ahead} ahead, ${behind} behind).`;
  } else if (behind > 0) {
    const plural = behind === 1 ? "commit" : "commits";
    warning = `[deft branch] Local ${branch} is behind ${upstream} by ${behind} ${plural}.`;
  } else {
    const plural = ahead === 1 ? "commit" : "commits";
    warning = `[deft branch] Local ${branch} is ahead of ${upstream} by ${ahead} ${plural}.`;
  }
  return { branch, upstream, ahead, behind, warning };
}

/**
 * Resolve SCM readiness for session orientation (#2275).
 * Shallow by default (PATH + auth status); deep when optional network is on.
 * Never throws — session:start must not hard-block on SCM absence.
 */
function resolveSessionScmReadiness(
  options: SessionStartOptions,
  allowOptionalNetwork: boolean,
): ScmReadinessReport {
  const probe = options.probeScm ?? probeScmReadiness;
  try {
    return probe({
      depth: allowOptionalNetwork ? "deep" : "shallow",
      env: options.env,
    });
  } catch {
    return {
      ready: false,
      binary: null,
      binaryPath: null,
      authState: "unknown",
      githubAuthMode: "host-gh",
      runtimeMode: "local-unsandboxed",
      injectedTokenPresent: false,
      depth: allowOptionalNetwork ? "deep" : "shallow",
      detail: "SCM readiness probe failed unexpectedly; treating SCM-dependent gates as skipped",
      remediation: null,
      skippedGates: [
        "triage:queue",
        "issue:ingest",
        "pr:*",
        "reconcile:issues",
        "cache:fetch-all",
        "scm:*",
      ],
      login: null,
      failureKind: "probe_error",
    };
  }
}

function runReadOnlySessionStart(
  projectRoot: string,
  options: SessionStartOptions,
  instant: Date,
  environment: EnvironmentContext,
): SessionStartResult {
  const lines: string[] = [];
  const resolveUserMd =
    options.resolveUserMd ?? ((root) => resolveUserMdPath({ projectRoot: root }));
  const userMd = resolveUserMd(projectRoot);
  const safePath = userMd.path.replace(/\r?\n/g, " ");
  const safeDiagnostic = userMd.diagnostic.replace(/\r?\n/g, " ");
  const userMdLine = userMd.found
    ? `USER.md resolved (${userMd.rung}): ${safePath}`
    : safeDiagnostic;
  // #2275: report SCM availability even on read-only alignment (shallow; no network).
  const scm = resolveSessionScmReadiness(options, false);
  lines.push(READ_ONLY_ALIGNMENT_MESSAGE);
  lines.push(userMdLine);
  lines.push(formatEnvironmentContext(environment));
  lines.push(...formatScmReadinessLines(scm));
  const resultPayload = {
    ready: true,
    exit_code: 0,
    posture: READ_ONLY_POSTURE,
    state_path: null,
    quick_steps: {
      alignment: ritualStep({
        ok: true,
        ts: instant,
        message: `${READ_ONLY_ALIGNMENT_MESSAGE} ${userMdLine}`,
      }),
    },
    gated_steps: {},
    user_md: {
      path: userMd.path,
      rung: userMd.rung,
      found: userMd.found,
      diagnostic: userMd.diagnostic,
    },
    environment: environmentContextToDict(environment),
    scm: scmReadinessToDict(scm),
    message: READ_ONLY_RESULT_MESSAGE,
  };
  return { code: 0, payload: resultPayload, lines };
}

function runSessionRearm(
  projectRoot: string,
  options: SessionStartOptions,
  instant: Date,
  environment: EnvironmentContext,
): SessionStartResult {
  const overallStarted = performance.now();
  const runGit = options.runGit ?? defaultGitRunner;
  const eligibility = assessRearmEligibility(projectRoot, { runGit });
  if (!eligibility.eligible) {
    const coldCmd = formatSessionStartRecoveryCommand("cold");
    const message = `${REARM_INELIGIBLE_PREFIX} ${eligibility.reason}. Run \`${coldCmd}\`.`;
    // #2994: still record failed attempt duration for process-cost rollups.
    emitSessionStartProcessCost(
      {
        ceremonyTier: REARM_CEREMONY_TIER,
        durationMs: elapsedMs(overallStarted),
        exitCode: 1,
        ready: false,
        optionalNetwork: false,
      },
      { projectRoot },
    );
    return {
      code: 1,
      payload: {
        ready: false,
        exit_code: 1,
        ceremony_tier: REARM_CEREMONY_TIER,
        rearm_eligible: false,
        environment: environmentContextToDict(environment),
        message,
      },
      lines: [formatEnvironmentContext(environment), message],
    };
  }

  const resolveUserMd =
    options.resolveUserMd ?? ((root) => resolveUserMdPath({ projectRoot: root }));
  const userMd = resolveUserMd(projectRoot);
  const safePath = userMd.path.replace(/\r?\n/g, " ");
  const safeDiagnostic = userMd.diagnostic.replace(/\r?\n/g, " ");
  const userMdLine = userMd.found
    ? `USER.md resolved (${userMd.rung}): ${safePath}`
    : safeDiagnostic;
  const alignmentMessage = `${READ_ONLY_ALIGNMENT_MESSAGE} ${userMdLine}`;
  // #2275: re-arm still reports SCM state (shallow; no network).
  const scm = resolveSessionScmReadiness(options, false);

  const lines: string[] = [
    READ_ONLY_ALIGNMENT_MESSAGE,
    userMdLine,
    formatEnvironmentContext(environment),
    ...formatScmReadinessLines(scm),
    REARM_SKIPPED_FAT_PATH_MESSAGE,
  ];

  // Light branch-policy disclosure (local only) so re-arm still surfaces policy state.
  const policyResult = resolvePolicy(projectRoot);
  const policyMessage = disclosureLine(policyResult);
  lines.push(policyMessage);
  const humanMerge = resolveHumanMergePolicy(projectRoot);
  const humanMergeLine = humanMergeDisclosureLine(humanMerge);
  if (humanMergeLine !== null) {
    lines.push(humanMergeLine);
  }

  const priorQuick = eligibility.state.quickSteps;
  const priorTriage = priorQuick.triage_welcome ?? ritualStep({ ok: true, ts: instant });
  const policyOk = policyResult.error === null || policyResult.source === "default-fail-closed";
  const quickSteps: Record<string, Record<string, unknown>> = {
    alignment: ritualStep({
      ok: true,
      ts: instant,
      message: alignmentMessage,
      durationMs: 0,
    }),
    branch_policy: ritualStep({
      ok: policyOk,
      ts: instant,
      message: policyMessage,
      exitCode: policyOk ? 0 : 2,
      durationMs: 0,
    }),
    // Preserve prior triage outcome; do not re-run welcome / self-heal on re-arm.
    triage_welcome: {
      ...priorTriage,
      ts: ritualStep({ ok: priorTriage.ok === true, ts: instant }).ts,
      message:
        typeof priorTriage.message === "string"
          ? priorTriage.message
          : "triage welcome preserved on re-arm",
    },
  };
  const gatedSteps = restampSteps(eligibility.state.gatedSteps, instant);

  const writeStarted = performance.now();
  // Fresh payload (no rearm_needed / compact_resume_at) clears compact markers (#2992).
  const writePayload: Record<string, unknown> = {
    ...newRitualStatePayload({
      sessionId: (options.newSessionId ?? randomUUID)(),
      gitHead: eligibility.currentHead,
      worktreePath: eligibility.currentWorktree,
      startedAt: instant,
      quickSteps,
      gatedSteps,
    }),
    ceremony_tier: REARM_CEREMONY_TIER,
  };
  let statePath: string;
  try {
    statePath = writeRitualState(projectRoot, writePayload);
  } catch (cause) {
    // #2994: still record failed attempt when ritual-state write throws.
    emitSessionStartProcessCost(
      {
        ceremonyTier: REARM_CEREMONY_TIER,
        durationMs: elapsedMs(overallStarted),
        exitCode: 2,
        ready: false,
        optionalNetwork: false,
        steps: [
          { name: "alignment", duration_ms: 0 },
          { name: "branch_policy", duration_ms: 0 },
          { name: "verify_tools", duration_ms: 0, skipped: true },
          { name: "triage_welcome", duration_ms: 0, skipped: true },
          { name: "release_probe", duration_ms: 0, skipped: true },
          { name: "ritual_write", duration_ms: elapsedMs(writeStarted) },
        ],
      },
      { projectRoot },
    );
    throw cause;
  }
  const stepTimings: SessionStartStepTiming[] = [
    { name: "alignment", duration_ms: 0 },
    { name: "branch_policy", duration_ms: 0 },
    { name: "verify_tools", duration_ms: 0, skipped: true },
    { name: "triage_welcome", duration_ms: 0, skipped: true },
    { name: "release_probe", duration_ms: 0, skipped: true },
    { name: "ritual_write", duration_ms: elapsedMs(writeStarted) },
  ];
  const totalMs = elapsedMs(overallStarted);
  const failed = Object.entries(quickSteps)
    .filter(([, step]) => !step.ok && !step.deferred_reason)
    .map(([name]) => name);
  const code = failed.length > 0 ? 1 : 0;
  // #2994: local process-cost event (best-effort; never blocks ceremony).
  emitSessionStartProcessCost(
    {
      ceremonyTier: REARM_CEREMONY_TIER,
      durationMs: totalMs,
      exitCode: code,
      ready: code === 0,
      optionalNetwork: false,
      steps: stepTimings,
    },
    { projectRoot },
  );
  return {
    code,
    payload: {
      ready: code === 0,
      exit_code: code,
      ceremony_tier: REARM_CEREMONY_TIER,
      rearm_eligible: true,
      state_path: statePath,
      quick_steps: quickSteps,
      gated_steps: gatedSteps,
      steps: stepTimings,
      duration_ms: totalMs,
      optional_network: false,
      user_md: {
        path: userMd.path,
        rung: userMd.rung,
        found: userMd.found,
        diagnostic: userMd.diagnostic,
      },
      environment: environmentContextToDict(environment),
      scm: scmReadinessToDict(scm),
      message: code === 0 ? "session ritual re-armed" : "session ritual re-arm failed",
    },
    lines,
  };
}

export function runSessionStart(
  projectRoot: string,
  options: SessionStartOptions = {},
): SessionStartResult {
  const posture = options.posture ?? MUTATION_POSTURE;
  const instant = options.now ?? new Date();
  const deferrals = options.deferrals ?? {};
  const runGit = options.runGit ?? defaultGitRunner;
  const environment = (options.probeEnvironment ?? detectEnvironmentContext)();
  const ceremonyTier = options.ceremonyTier ?? COLD_CEREMONY_TIER;

  // #2926: official root opt-out wins locally — skip Directive session ritual.
  // disabled = skip ritual (exit 0 clean / 1 inconsistent). ready stays false so
  // automation does not treat opt-out as "session fully initialized for work".
  const optOut = detectNoDeftDirective(projectRoot);
  if (optOut.present) {
    const lines = [NO_DEFT_DIRECTIVE_DISABLED_MESSAGE];
    if (optOut.inconsistent) {
      lines.push(NO_DEFT_DIRECTIVE_INCONSISTENT_MESSAGE);
    }
    const code = optOut.inconsistent ? 1 : 0;
    return {
      code,
      payload: {
        ready: false,
        exit_code: code,
        disabled: true,
        disabled_via: NO_DEFT_DIRECTIVE_FLAG_NAME,
        inconsistent: optOut.inconsistent,
        inconsistent_policy: optOut.inconsistent
          ? NO_DEFT_DIRECTIVE_INCONSISTENT_POLICY
          : undefined,
        deposit_present: optOut.depositPresent,
        posture,
        environment: environmentContextToDict(environment),
        message: NO_DEFT_DIRECTIVE_DISABLED_MESSAGE,
      },
      lines,
    };
  }

  if (posture === READ_ONLY_POSTURE) {
    return runReadOnlySessionStart(projectRoot, options, instant, environment);
  }

  // #2992: re-arm path refreshes clock/bind without fat cold ceremony.
  if (ceremonyTier === REARM_CEREMONY_TIER) {
    return runSessionRearm(projectRoot, options, instant, environment);
  }

  const overallStarted = performance.now();
  const stepTimings: SessionStartStepTiming[] = [];
  const allowOptionalNetwork = resolveSessionStartOptionalNetwork(options);

  const { head: gitHeadValue, error: gitError } = gitHead(projectRoot, runGit);
  if (gitHeadValue === null) {
    const payload = {
      ready: false,
      exit_code: 2,
      ceremony_tier: COLD_CEREMONY_TIER,
      environment: environmentContextToDict(environment),
      message: gitError ?? "could not resolve git HEAD",
    };
    // #2994: still record failed attempt duration for process-cost rollups.
    emitSessionStartProcessCost(
      {
        ceremonyTier: COLD_CEREMONY_TIER,
        durationMs: elapsedMs(overallStarted),
        exitCode: 2,
        ready: false,
        optionalNetwork: allowOptionalNetwork,
      },
      { projectRoot },
    );
    return {
      code: 2,
      payload,
      lines: [formatEnvironmentContext(environment), payload.message as string],
    };
  }

  const quickSteps: Record<string, Record<string, unknown>> = recordDeferredSteps(
    QUICK_STEPS,
    deferrals,
    instant,
  );
  const gatedSteps: Record<string, Record<string, unknown>> = recordDeferredSteps(
    GATED_STEPS,
    deferrals,
    instant,
  );
  const lines: string[] = [];

  // Resolve USER.md via the shared first-hit-wins resolver so the alignment
  // step finds preferences automatically in mismatched / headless sandboxes
  // with zero manual DEFT_USER_PATH (#2271 / #2124). Never throws: an absent
  // USER.md degrades to a clear diagnostic below.
  const resolveUserMd =
    options.resolveUserMd ?? ((root) => resolveUserMdPath({ projectRoot: root }));
  const userMd = resolveUserMd(projectRoot);

  if (!quickSteps.alignment) {
    const stepStarted = performance.now();
    const message = "Deft Directive active -- AGENTS.md loaded.";
    // Sanitize newlines on the data-derived path/diagnostic before they land in
    // the ritual-step message / terminal output (matches doctor's CWE-116
    // handling); DEFT_USER_PATH is only trimmed, so an embedded newline could
    // otherwise survive into multi-line output.
    const safePath = userMd.path.replace(/\r?\n/g, " ");
    const safeDiagnostic = userMd.diagnostic.replace(/\r?\n/g, " ");
    const userMdLine = userMd.found
      ? `USER.md resolved (${userMd.rung}): ${safePath}`
      : safeDiagnostic;
    const durationMs = elapsedMs(stepStarted);
    quickSteps.alignment = ritualStep({
      ok: true,
      ts: instant,
      message: `${message} ${userMdLine}`,
      durationMs,
    });
    stepTimings.push({ name: "alignment", duration_ms: durationMs });
    lines.push(message);
    lines.push(userMdLine);
  } else {
    stepTimings.push({ name: "alignment", duration_ms: 0, skipped: true });
  }
  lines.push(formatEnvironmentContext(environment));

  // #2275: SCM tooling + auth readiness — shallow on hot path, deep with --with-network.
  // Never fails session:start; reports which SCM-dependent gates are skipped.
  const scmStepStarted = performance.now();
  const scm = resolveSessionScmReadiness(options, allowOptionalNetwork);
  lines.push(...formatScmReadinessLines(scm));
  stepTimings.push({ name: "scm_readiness", duration_ms: elapsedMs(scmStepStarted) });

  if (!quickSteps.branch_policy) {
    const stepStarted = performance.now();
    const result = resolvePolicy(projectRoot);
    const message = disclosureLine(result);
    const ok = result.error === null || result.source === "default-fail-closed";
    lines.push(message);
    // Human merge gate disclosure (#1193) — surface when ON (or env bypass active).
    const humanMerge = resolveHumanMergePolicy(projectRoot);
    const humanMergeLine = humanMergeDisclosureLine(humanMerge);
    if (humanMergeLine !== null) {
      lines.push(humanMergeLine);
    }
    const branchSync = defaultBranchSync(projectRoot, runGit);
    if (branchSync.warning) {
      lines.push(branchSync.warning);
    }
    const durationMs = elapsedMs(stepStarted);
    quickSteps.branch_policy = ritualStep({
      ok,
      ts: instant,
      message,
      exitCode: ok ? 0 : 2,
      durationMs,
    });
    stepTimings.push({ name: "branch_policy", duration_ms: durationMs });
  } else {
    stepTimings.push({ name: "branch_policy", duration_ms: 0, skipped: true });
  }

  {
    const stepStarted = performance.now();
    const verifyToolsFn =
      options.verifyTools ??
      ((output) => {
        const toolLines: string[] = [];
        const result = verifyRequiredTools({ outputFn: (line) => toolLines.push(line) });
        for (const line of toolLines) {
          output(line);
        }
        return { exitCode: result.exitCode };
      });
    verifyToolsFn((line) => lines.push(line));
    stepTimings.push({ name: "verify_tools", duration_ms: elapsedMs(stepStarted) });
  }

  if (!quickSteps.triage_welcome) {
    const stepStarted = performance.now();
    const captured: string[] = [];
    const triageCommand = ["triage_welcome.run_default_mode", "--project-root", projectRoot];
    try {
      const runWelcome =
        options.runTriageWelcome ??
        ((root, welcomeOpts) => {
          const outcome = runDefaultMode(root, {
            output: welcomeOpts.output,
            writeHistory: welcomeOpts.writeHistory,
            now: welcomeOpts.now,
            // #2991: default hot path skips ensureTriageCacheHydrated / maybeSelfHealCache.
            selfHealFn: allowOptionalNetwork
              ? undefined
              : () => {
                  /* no network cache work on hot path */
                },
          });
          return { exitCode: outcome.exitCode };
        });
      const outcome = runWelcome(projectRoot, {
        writeHistory: options.writeHistory !== false,
        now: instant,
        output: (line) => captured.push(line),
      });
      const ok = outcome.exitCode === 0;
      const message = captured.join("\n").trim() || "triage welcome completed";
      const durationMs = elapsedMs(stepStarted);
      quickSteps.triage_welcome = ritualStep({
        ok,
        ts: instant,
        message,
        exitCode: outcome.exitCode,
        command: triageCommand,
        durationMs,
      });
      stepTimings.push({ name: "triage_welcome", duration_ms: durationMs });
      lines.push(...captured);
    } catch (exc) {
      const message = `triage welcome failed: ${String(exc)}`;
      const durationMs = elapsedMs(stepStarted);
      quickSteps.triage_welcome = ritualStep({
        ok: false,
        ts: instant,
        message,
        exitCode: 2,
        command: triageCommand,
        durationMs,
      });
      stepTimings.push({ name: "triage_welcome", duration_ms: durationMs });
      lines.push(message);
    }
  } else {
    stepTimings.push({ name: "triage_welcome", duration_ms: 0, skipped: true });
  }

  // #2991: npm release probe is optional network — off by default so ritual write is not blocked.
  if (allowOptionalNetwork) {
    const stepStarted = performance.now();
    try {
      const releaseAvailability = (
        options.probeReleaseAvailability ?? probeSessionReleaseAvailability
      )(projectRoot, { now: instant });
      lines.push(...releaseAvailability.lines);
    } catch {
      // Release availability is a best-effort operator advisory, never a session blocker.
    }
    stepTimings.push({ name: "release_probe", duration_ms: elapsedMs(stepStarted) });
  } else {
    stepTimings.push({ name: "release_probe", duration_ms: 0, skipped: true });
    lines.push(OPTIONAL_NETWORK_SKIPPED_MESSAGE);
  }

  try {
    const tickler = (options.runStalenessTickler ?? maybeRunStalenessTickler)(projectRoot, {
      now: instant,
    });
    lines.push(...tickler.lines);
  } catch {
    // Staleness tickler is best-effort and must never block session start.
  }

  if (!runningInsideDeftRepo(projectRoot) && shouldEmitMigrateNudge(projectRoot)) {
    lines.push(MIGRATE_COMPLETION_NUDGE);
  }

  try {
    emitSessionValueReadback(projectRoot, {
      output: (line) => lines.push(line),
      writeHistory: options.writeHistory !== false,
    });
  } catch {
    // observability only — session start must not abort on transient readback I/O
  }

  try {
    emitSessionEvalReadback(projectRoot, {
      output: (line) => lines.push(line),
      writeHistory: options.writeHistory !== false,
    });
  } catch {
    // observability only — session start must not abort on transient eval readback I/O
  }

  const consentPrompt = maybeFormatProductSignalConsentPrompt({ projectRoot });
  if (consentPrompt.length > 0) {
    lines.push(consentPrompt.trimEnd());
  }

  const writeStarted = performance.now();
  const payload = newRitualStatePayload({
    sessionId: (options.newSessionId ?? randomUUID)(),
    gitHead: gitHeadValue,
    worktreePath: worktreePath(projectRoot, runGit),
    startedAt: instant,
    quickSteps,
    gatedSteps,
  });
  let statePath: string;
  try {
    statePath = writeRitualState(projectRoot, payload);
  } catch (cause) {
    // #2994: still record failed attempt when ritual-state write throws.
    stepTimings.push({ name: "ritual_write", duration_ms: elapsedMs(writeStarted) });
    emitSessionStartProcessCost(
      {
        ceremonyTier: COLD_CEREMONY_TIER,
        durationMs: elapsedMs(overallStarted),
        exitCode: 2,
        ready: false,
        optionalNetwork: allowOptionalNetwork,
        steps: stepTimings,
      },
      { projectRoot },
    );
    throw cause;
  }
  stepTimings.push({ name: "ritual_write", duration_ms: elapsedMs(writeStarted) });

  const failed = Object.entries(quickSteps)
    .filter(([, step]) => !step.ok && !step.deferred_reason)
    .map(([name]) => name);
  const code = failed.length > 0 ? 1 : 0;
  const totalMs = elapsedMs(overallStarted);
  const resultPayload = {
    ready: code === 0,
    exit_code: code,
    ceremony_tier: COLD_CEREMONY_TIER,
    state_path: statePath,
    quick_steps: quickSteps,
    gated_steps: gatedSteps,
    steps: stepTimings,
    duration_ms: totalMs,
    optional_network: allowOptionalNetwork,
    user_md: {
      path: userMd.path,
      rung: userMd.rung,
      found: userMd.found,
      diagnostic: userMd.diagnostic,
    },
    environment: environmentContextToDict(environment),
    scm: scmReadinessToDict(scm),
    message: code === 0 ? "session ritual recorded" : "session ritual failed",
  };
  // #2994: local process-cost event (best-effort; never blocks ceremony).
  emitSessionStartProcessCost(
    {
      ceremonyTier: COLD_CEREMONY_TIER,
      durationMs: totalMs,
      exitCode: code,
      ready: code === 0,
      optionalNetwork: allowOptionalNetwork,
      steps: stepTimings,
    },
    { projectRoot },
  );
  return { code, payload: resultPayload, lines };
}

export { ritualStatePath };
