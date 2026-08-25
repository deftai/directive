import { runningInsideDeftRepo } from "../doctor/paths.js";
import { emitSessionEvalReadback } from "../eval/readback.js";
import { bindSessionGeneration } from "../freshness/bind.js";
import { readLiveGeneration } from "../freshness/generation.js";
import { MIGRATE_COMPLETION_NUDGE, shouldEmitMigrateNudge } from "../init-deposit/migrate.js";
import {
  evaluateLifecycleVisible,
  formatLifecycleVisibleSessionLines,
  type LifecycleVisibleResult,
} from "../lifecycle-visible/evaluate.js";
import {
  type HostContentSurfaceSeams,
  hostContentSurfaceToDict,
  maybeFormatHostContentSurfaceLines,
} from "../platform/host-content-surface.js";
import {
  detectEnvironmentContext,
  type EnvironmentContext,
  environmentContextToDict,
  formatEnvironmentContext,
} from "../platform/shell-context.js";
import {
  type CeremonyDialInputs,
  type CeremonyDialSelection,
  ceremonyDialToDict,
  formatCeremonyDialStatusLine,
  mergeCeremonyDialDeferrals,
  type ProvisionalCeremonyEstimateHints,
  resolveCeremonyDial,
  resolveSessionCeremonyDialInputs,
} from "../policy/ceremony-dial.js";
import {
  type CeremonyStartTierProvenance,
  emitCeremonyDialEscalationEvaluation,
  evaluateSessionStartCeremonyDialEscalation,
  formatCeremonyDialPinBypassLine,
  isCeremonyStartTierPinned,
  resolveCeremonyStartTierProvenance,
} from "../policy/ceremony-dial-escalation.js";
import { maybeFormatCoverageCheckResumeDisclosure } from "../policy/coverage-debt.js";
import {
  DEFT_DIRECTIVE_DISABLE_FLAG_NAME,
  DEFT_DIRECTIVE_DISABLE_STATUS,
  detectDeftDirectiveDisable,
  formatDeftDirectiveDisableMessage,
  isDeftDirectiveDisableActive,
} from "../policy/deft-directive-disable.js";
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
import { RunSummaryEmitter } from "../run-summary/emit.js";
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
import {
  ceremonyDialEvidenceToDict,
  collectCeremonyDialConsumerEvidence,
  formatCeremonyDialEvidenceLine,
  mergeCeremonyDialInputsWithConsumerEvidence,
} from "./ceremony-dial-evidence.js";
import {
  type DetectHardEffortBudgetInput,
  effortBudgetToDict,
  type HardEffortBudget,
  maybeFormatEffortBudgetLines,
  resolveProductionHostEffortDescriptor,
} from "./effort-budget.js";
import type { GitRunner } from "./git.js";
import { defaultGitRunner, gitHead, gitIsAncestor, worktreePath } from "./git.js";
import {
  type ApplyOccupancyInput,
  applyWorktreeOccupancy,
  type OccupancyDecision,
} from "./occupancy.js";
import {
  type OrientationBundle,
  type RunOrientationOptions,
  resolveSessionCompact,
  runOrientationCompression,
} from "./orientation-compression.js";
import { emitSessionStartProcessCost, formatSessionStartCeremonyCostLine } from "./process-cost.js";
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
import { timestampIso } from "./time.js";
import {
  runToolchainPreflight,
  type ToolchainPreflightOptions,
  type ToolchainPreflightResult,
  toolchainPreflightToDict,
} from "./toolchain-preflight.js";

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

// verify_tools is mutation readiness recorded on cold path (#3214 / #3156) —
// included so re-arm refuses after a tools-failed cold start.
export const QUICK_STEPS = [
  "alignment",
  "branch_policy",
  "triage_welcome",
  "verify_tools",
] as const;
/** Session / full gated ritual set. Write dispatch uses a per-surface subset (#3738). */
export const GATED_STEPS = ["agent_hooks", "doctor", "cache_fresh"] as const;
export type GatedStepName = (typeof GATED_STEPS)[number];

/**
 * Gated steps a write/spawn mutation must prove from recorded ritual state (#3738).
 * `cache_fresh` is a work-selection precondition, not a write-authorization one.
 */
export const WRITE_GATED_REQUIRED_STEPS = [
  "agent_hooks",
  "doctor",
] as const satisfies readonly GatedStepName[];

/**
 * Gated steps the write path may execute (#3738).
 * Hook readiness is deliberately non-cacheable; doctor and cache_fresh stay
 * session-surface only.
 */
export const WRITE_GATED_EXECUTE_STEPS = [
  "agent_hooks",
] as const satisfies readonly GatedStepName[];

/** Per-clone ignore/index hide of lifecycle roots — warn-only (#3505). */
function pushLifecycleVisibleAdvisory(
  lines: string[],
  projectRoot: string,
  options: SessionStartOptions,
  runGit: GitRunner,
): void {
  try {
    const probe =
      options.probeLifecycleVisible ??
      ((root, git) => evaluateLifecycleVisible({ projectRoot: root, runGit: git }));
    const result = probe(projectRoot, runGit);
    lines.push(...formatLifecycleVisibleSessionLines(result));
  } catch {
    // best-effort — session:start must not abort on a clone-local advisory
  }
}

/** Standing one-liner when coverageDebt/checkResume is non-default (#3314). */
function pushCoverageCheckResumeDisclosure(lines: string[], projectRoot: string): void {
  try {
    const line = maybeFormatCoverageCheckResumeDisclosure(projectRoot);
    if (line !== null) {
      lines.push(line);
    }
  } catch {
    // best-effort — ritual must not abort
  }
}

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
  /** #3433: steal the worktree occupancy lease. Requires confirm + occupant. */
  readonly steal?: boolean;
  readonly confirm?: boolean;
  readonly occupant?: string;
  readonly occupancyIntent?: ApplyOccupancyInput["intent"];
  readonly applyOccupancy?: (projectRoot: string, input: ApplyOccupancyInput) => OccupancyDecision;
  readonly runTriageWelcome?: (
    projectRoot: string,
    options: { writeHistory: boolean; now: Date; output: (line: string) => void },
  ) => { exitCode: number };
  readonly verifyTools?: (output: (line: string) => void) => { exitCode: number };
  readonly resolveUserMd?: (projectRoot: string) => ResolveUserMdResult;
  readonly probeEnvironment?: () => EnvironmentContext;
  /**
   * #3162: host content-surface class + managed-section drift seams (tests inject).
   * Fail-open advisory only — never blocks session:start.
   */
  readonly hostContentSurfaceSeams?: HostContentSurfaceSeams;
  /**
   * #3266: hard effort-budget detection seams (env / host descriptor).
   * Fail-open advisory only — never blocks session:start.
   */
  readonly effortBudgetSeams?: DetectHardEffortBudgetInput;
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
  /**
   * #3505: per-clone lifecycle-root visibility (ignore / skip-worktree).
   * Warn-only; never blocks session:start. Inject in tests.
   */
  readonly probeLifecycleVisible?: (
    projectRoot: string,
    runGit: GitRunner,
  ) => LifecycleVisibleResult;
  /**
   * #3214: ceremony dial inputs (task size × model tier × project shape).
   * Missing fields are filled by the headless provisional classifier
   * (env / verb / file-scope / deposit layout) — no plan-item effort (#1581).
   */
  readonly ceremonyDialInputs?: CeremonyDialInputs;
  /**
   * #3214: optional intake hints for provisional size (prompt/verb/files).
   * Vanilla deposit session:start runs provisional fill without policy opt-in.
   */
  readonly ceremonyDialHints?: Omit<ProvisionalCeremonyEstimateHints, "projectRoot" | "env">;
  /**
   * #3214: optional pre-resolved dial (tests). When omitted, resolveCeremonyDial
   * loads plan.policy.ceremonyDial and applies inputs (after provisional fill).
   */
  readonly ceremonyDial?: CeremonyDialSelection;
  /**
   * #3319: start-tier provenance hint. CLI `--ceremony-depth` / harness pin
   * should pass `external-pin`. Policy override is inferred as `operator`.
   */
  readonly ceremonyDialStartTierProvenance?: CeremonyStartTierProvenance;
  /**
   * #3282: done-gate toolchain preflight seams (tests inject result or probe).
   * When omitted, runs live preflight after verify_tools on cold path.
   * #3286: preflight is composed into orientation sections with doctor +
   * deposit-sha fast-paths for agents:refresh / cache-fresh.
   */
  readonly toolchainPreflight?: ToolchainPreflightResult | null;
  readonly toolchainPreflightOptions?: ToolchainPreflightOptions;
  /** #3282: disable run-summary emission (tests). */
  readonly emitRunSummary?: boolean;
  /** #3282: framework root for CLI dist probe (defaults to projectRoot). */
  readonly frameworkRoot?: string;
  /**
   * #3286: compact orientation output (terse machine lines). Default verbose.
   * CLI: `--compact`; env: `DEFT_SESSION_COMPACT=1`.
   */
  readonly compact?: boolean;
  /**
   * #3286: orientation compression seams (tests inject full bundle or partial
   * section overrides). When `orientation === null`, skip composition entirely.
   */
  readonly orientation?: OrientationBundle | null;
  readonly orientationOptions?: Partial<RunOrientationOptions>;
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
    const step = state.quickSteps[stepName];
    // Legacy ritual-state (pre-#3214 tools persistence) omits verify_tools —
    // treat missing as pass; explicit failure still refuses re-arm.
    if (stepName === "verify_tools" && (step === undefined || step === null)) {
      continue;
    }
    if (!stepPassesForRearm(step)) {
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
    if (stepName === "agent_hooks") {
      errors.push('ritual step "agent_hooks" is not deferrable');
      continue;
    }
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

function resolveHostContentSurface(
  projectRoot: string,
  options: SessionStartOptions,
  runtimeMode?: string | null,
): { report: ReturnType<typeof maybeFormatHostContentSurfaceLines>["report"]; lines: string[] } {
  try {
    const seams = options.hostContentSurfaceSeams ?? {};
    return maybeFormatHostContentSurfaceLines(projectRoot, {
      ...seams,
      environ: seams.environ ?? options.env,
      runtimeMode: seams.runtimeMode ?? runtimeMode ?? null,
    });
  } catch {
    // best-effort — session start must not abort on host-surface probe failures (#3162)
    return {
      report: {
        contentClass: "unknown",
        classSource: "probe-error",
        signals: [],
        managedSection: {
          state: "unknown",
          embeddedSha: null,
          bodyHash: null,
          path: `${projectRoot}/AGENTS.md`,
        },
        runtimeMode: null,
      },
      lines: [],
    };
  }
}

function resolveEffortBudget(options: SessionStartOptions): {
  budget: HardEffortBudget;
  lines: string[];
} {
  try {
    const seams = options.effortBudgetSeams ?? {};
    const environ = seams.environ ?? options.env ?? process.env;
    // Production host adapter (#3266 / #1461): always resolve a descriptor from env
    // (and CLI-forwarded seams) so host-native max-turns/budget signals are not lost.
    const productionHost = resolveProductionHostEffortDescriptor(environ);
    const hostDescriptor =
      seams.hostDescriptor !== undefined && seams.hostDescriptor !== null
        ? { ...productionHost, ...seams.hostDescriptor }
        : productionHost;
    return maybeFormatEffortBudgetLines({
      environ,
      hostDescriptor,
    });
  } catch {
    // best-effort — session start must not abort on effort-budget probe failures (#3266)
    return {
      budget: {
        detected: false,
        posture: "unbounded",
        kind: "none",
        maxTurns: null,
        maxBudget: null,
        remainingTurns: null,
        remainingBudget: null,
        sources: [],
      },
      lines: [],
    };
  }
}

function occupancyInput(
  options: SessionStartOptions,
  now: Date,
  write: boolean,
): ApplyOccupancyInput {
  return {
    env: options.env,
    now,
    newSessionId: options.newSessionId,
    steal: options.steal,
    confirm: options.confirm,
    occupant: options.occupant,
    intent: options.occupancyIntent ?? "mutation",
    write,
  };
}

function runOccupancy(
  projectRoot: string,
  options: SessionStartOptions,
  now: Date,
  write: boolean,
): OccupancyDecision {
  const apply = options.applyOccupancy ?? applyWorktreeOccupancy;
  return apply(projectRoot, occupancyInput(options, now, write));
}

function occupancyDeniedResult(
  occupancy: OccupancyDecision,
  environment: EnvironmentContext,
): SessionStartResult {
  return {
    code: occupancy.code,
    payload: {
      ready: false,
      exit_code: occupancy.code,
      posture: MUTATION_POSTURE,
      occupancy: {
        action: occupancy.action,
        session_id: occupancy.sessionId,
        occupant_id: occupancy.record?.sessionId ?? null,
      },
      environment: environmentContextToDict(environment),
      message: occupancy.message,
    },
    lines: occupancy.message.split("\n"),
  };
}

function persistOccupancyOrDeny(
  projectRoot: string,
  options: SessionStartOptions,
  now: Date,
  environment: EnvironmentContext,
): OccupancyDecision | SessionStartResult {
  const occupancy = runOccupancy(projectRoot, options, now, true);
  if (occupancy.code !== 0) return occupancyDeniedResult(occupancy, environment);
  return occupancy;
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
  // #3162: host content-surface class + managed drift (advisory).
  const hostSurface = resolveHostContentSurface(projectRoot, options, scm.runtimeMode);
  // #3266: hard effort-budget detection (advisory; bank-the-pass guidance).
  const effortBudget = resolveEffortBudget(options);
  lines.push(READ_ONLY_ALIGNMENT_MESSAGE);
  lines.push(userMdLine);
  lines.push(formatEnvironmentContext(environment));
  lines.push(...formatScmReadinessLines(scm));
  lines.push(...hostSurface.lines);
  lines.push(...effortBudget.lines);
  const runGit = options.runGit ?? defaultGitRunner;
  pushLifecycleVisibleAdvisory(lines, projectRoot, options, runGit);
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
    host_content_surface: hostContentSurfaceToDict(hostSurface.report),
    effort_budget: effortBudgetToDict(effortBudget.budget),
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

  const plannedOccupancy = runOccupancy(projectRoot, options, instant, options.steal === true);
  if (plannedOccupancy.code !== 0) {
    return occupancyDeniedResult(plannedOccupancy, environment);
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
  // #3162: host content-surface class + managed drift (advisory).
  const hostSurface = resolveHostContentSurface(projectRoot, options, scm.runtimeMode);
  // #3266: hard effort-budget detection (advisory).
  const effortBudget = resolveEffortBudget(options);

  const lines: string[] = [
    READ_ONLY_ALIGNMENT_MESSAGE,
    userMdLine,
    formatEnvironmentContext(environment),
    ...formatScmReadinessLines(scm),
    ...hostSurface.lines,
    ...effortBudget.lines,
    REARM_SKIPPED_FAT_PATH_MESSAGE,
  ];
  pushLifecycleVisibleAdvisory(lines, projectRoot, options, runGit);

  // Light branch-policy disclosure (local only) so re-arm still surfaces policy state.
  const policyResult = resolvePolicy(projectRoot);
  const policyMessage = disclosureLine(policyResult);
  lines.push(policyMessage);
  const humanMerge = resolveHumanMergePolicy(projectRoot);
  const humanMergeLine = humanMergeDisclosureLine(humanMerge);
  if (humanMergeLine !== null) {
    lines.push(humanMergeLine);
  }
  pushCoverageCheckResumeDisclosure(lines, projectRoot);

  const priorQuick = eligibility.state.quickSteps;
  const priorTriage = priorQuick.triage_welcome ?? ritualStep({ ok: true, ts: instant });
  // Greptile P1: legacy ritual-state without verify_tools must re-run tools —
  // never invent ok:true. When prior exists, preserve without re-run (#2992).
  let toolsStep: Record<string, unknown>;
  if (priorQuick.verify_tools && typeof priorQuick.verify_tools === "object") {
    const priorTools = priorQuick.verify_tools as Record<string, unknown>;
    toolsStep = {
      ...priorTools,
      ts: ritualStep({ ok: priorTools.ok === true, ts: instant }).ts,
      message:
        typeof priorTools.message === "string"
          ? priorTools.message
          : "verify:tools preserved on re-arm",
    };
  } else {
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
    const toolsOutcome = verifyToolsFn((line) => lines.push(line));
    const toolsOk = toolsOutcome.exitCode === 0;
    toolsStep = ritualStep({
      ok: toolsOk,
      ts: instant,
      message: toolsOk
        ? "verify:tools re-run on re-arm (legacy ritual lacked tools step)"
        : `verify:tools failed on re-arm (exit ${toolsOutcome.exitCode})`,
      exitCode: toolsOutcome.exitCode,
      durationMs: 0,
    });
  }
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
    verify_tools: toolsStep,
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
  const persistedOccupancy = persistOccupancyOrDeny(projectRoot, options, instant, environment);
  if ("payload" in persistedOccupancy) {
    return persistedOccupancy;
  }
  // #3433: keep DEFT_SESSION_ID / occupant id. Do not mint a new UUID on re-arm.
  const rearmSessionId = persistedOccupancy.sessionId;
  // Fresh payload (no rearm_needed / compact_resume_at) clears compact markers (#2992).
  const writePayload: Record<string, unknown> = {
    ...newRitualStatePayload({
      sessionId: rearmSessionId,
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

  // #3117: bind live deposit generation into session context on re-arm (host-agnostic).
  let freshnessBind: Record<string, unknown> | null = null;
  try {
    const bound = bindSessionGeneration(projectRoot, {
      sessionId: rearmSessionId,
      nowIso: timestampIso(instant),
      payloadLoaded: true,
    });
    freshnessBind = {
      bound_generation: bound.bound.boundGeneration,
      live_generation: bound.live.generation,
      content_version: bound.live.contentVersion,
      path: bound.path,
    };
    lines.push(
      `[deft freshness] bound generation ${bound.bound.boundGeneration} ` +
        `(live deposit v${bound.live.contentVersion})`,
    );
    lines.push(
      `[deft freshness] set DEFT_SESSION_ID=${rearmSessionId} for bare freshness:report/bind ` +
        `(or pass --session-id; required for multi-agent trusted readiness)`,
    );
  } catch {
    const live = readLiveGeneration(projectRoot);
    if (live !== null) {
      lines.push(
        `[deft freshness] live generation ${live.generation} present; session bind deferred ` +
          `(run \`deft freshness:bind\` after loading payload surfaces)`,
      );
    }
  }

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
  // #3508: operator-visible CLI process time. ⊗ not #3286 Later graduation input.
  if (!resolveSessionCompact({ compact: options.compact, env: options.env })) {
    lines.push(formatSessionStartCeremonyCostLine(REARM_CEREMONY_TIER, totalMs));
  }
  return {
    code,
    payload: {
      ready: code === 0,
      exit_code: code,
      ceremony_tier: REARM_CEREMONY_TIER,
      rearm_eligible: true,
      state_path: statePath,
      ...(freshnessBind ? { freshness: freshnessBind } : {}),
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
      host_content_surface: hostContentSurfaceToDict(hostSurface.report),
      effort_budget: effortBudgetToDict(effortBudget.budget),
      occupancy: {
        action: persistedOccupancy.action,
        session_id: rearmSessionId,
      },
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

  // #3039: local (untracked) test kill-switch — skip ritual write; deposit may remain.
  // Recovery requires delete + new session. Tracked flags do not short-circuit.
  if (isDeftDirectiveDisableActive(projectRoot)) {
    const killSwitch = detectDeftDirectiveDisable(projectRoot);
    const optOutAlso = detectNoDeftDirective(projectRoot);
    const message = formatDeftDirectiveDisableMessage({
      permanentOptOutAlsoPresent: optOutAlso.present,
      trackedByGit: false,
    });
    const lines = message.split("\n");
    return {
      code: 0,
      payload: {
        ready: false,
        exit_code: 0,
        disabled: true,
        disabled_via: DEFT_DIRECTIVE_DISABLE_FLAG_NAME,
        status: DEFT_DIRECTIVE_DISABLE_STATUS,
        kill_switch: true,
        inconsistent: false,
        deposit_present: killSwitch.depositPresent,
        tracked_by_git: false,
        permanent_opt_out_also_present: optOutAlso.present,
        posture,
        environment: environmentContextToDict(environment),
        message,
      },
      lines,
    };
  }

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

  // #3214 / #3156: select ritual (ceremony) depth before building deferral maps.
  // Rapid/minimal auto-defer informational cold steps only; mutation readiness
  // (doctor, cache_fresh, agent_hooks, verify_tools) stays constant.
  // Two-stage + provisional intake (#3214 / #3263 / #1581 ordering): fill
  // missing size/tier/shape from env/verb/files/deposit BEFORE resolve — never
  // block on plan-item effort (post-planning only). Cold incomplete size is
  // tier-conditional (#3263): mid/low → standard; frontier/unknown → rapid.
  // #3358: fill at least one consumer-supplied input (stamped clause count,
  // host-tier env, failing-gate count) so evaluation is not permanently
  // size=- / modelTier=-. ⊗ Change rapid default when no evidence exists.
  const consumerDialEvidence = collectCeremonyDialConsumerEvidence(projectRoot, {
    env: options.env,
  });
  const dialInputsWithEvidence =
    options.ceremonyDial === undefined
      ? mergeCeremonyDialInputsWithConsumerEvidence(
          options.ceremonyDialInputs,
          consumerDialEvidence,
        )
      : (options.ceremonyDialInputs ?? {});
  const { inputs: resolvedDialInputs, provisional: provisionalDial } =
    resolveSessionCeremonyDialInputs(projectRoot, dialInputsWithEvidence, {
      ...options.ceremonyDialHints,
      env: options.env,
    });
  const ceremonyDialSelection: CeremonyDialSelection =
    options.ceremonyDial ?? resolveCeremonyDial(projectRoot, { inputs: resolvedDialInputs });
  const startTierProvenance = resolveCeremonyStartTierProvenance({
    selection: ceremonyDialSelection,
    injectedSelection: options.ceremonyDial !== undefined,
    hint: options.ceremonyDialStartTierProvenance,
  });
  const effectiveDeferrals = mergeCeremonyDialDeferrals(deferrals, ceremonyDialSelection);
  const skipFatPath = ceremonyDialSelection.profile.skipFatPath;

  const { head: gitHeadValue, error: gitError } = gitHead(projectRoot, runGit);
  if (gitHeadValue === null) {
    const payload = {
      ready: false,
      exit_code: 2,
      ceremony_tier: COLD_CEREMONY_TIER,
      ceremony_dial: ceremonyDialToDict(ceremonyDialSelection),
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

  const plannedOccupancy = runOccupancy(projectRoot, options, instant, options.steal === true);
  if (plannedOccupancy.code !== 0) {
    return occupancyDeniedResult(plannedOccupancy, environment);
  }

  const quickSteps: Record<string, Record<string, unknown>> = recordDeferredSteps(
    QUICK_STEPS,
    effectiveDeferrals,
    instant,
  );
  const gatedSteps: Record<string, Record<string, unknown>> = recordDeferredSteps(
    GATED_STEPS,
    effectiveDeferrals,
    instant,
  );
  const lines: string[] = [];
  lines.push(
    formatCeremonyDialStatusLine(ceremonyDialSelection, {
      startTierProvenance,
    }),
  );
  const pinBypassLine = formatCeremonyDialPinBypassLine(startTierProvenance);
  if (pinBypassLine !== null) {
    lines.push(pinBypassLine);
  }
  if (provisionalDial.reasons.length > 0 && options.ceremonyDial === undefined) {
    lines.push(`[deft ceremony-dial] provisional: ${provisionalDial.reasons.join("; ")}`);
  }
  const evidenceLine = formatCeremonyDialEvidenceLine(consumerDialEvidence);
  if (evidenceLine !== null && options.ceremonyDial === undefined) {
    lines.push(evidenceLine);
  }

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

  // #3162: host content-surface class + managed AGENTS drift (advisory; never blocks).
  const hostSurfaceStepStarted = performance.now();
  const hostSurface = resolveHostContentSurface(projectRoot, options, scm.runtimeMode);
  lines.push(...hostSurface.lines);
  stepTimings.push({
    name: "host_content_surface",
    duration_ms: elapsedMs(hostSurfaceStepStarted),
  });

  // #3266: hard effort-budget detection (advisory; bank-the-pass guidance).
  const effortBudgetStepStarted = performance.now();
  const effortBudget = resolveEffortBudget(options);
  lines.push(...effortBudget.lines);
  stepTimings.push({
    name: "effort_budget",
    duration_ms: elapsedMs(effortBudgetStepStarted),
  });

  const lifecycleVisibleStarted = performance.now();
  pushLifecycleVisibleAdvisory(lines, projectRoot, options, runGit);
  stepTimings.push({
    name: "lifecycle_visible",
    duration_ms: elapsedMs(lifecycleVisibleStarted),
  });

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
  // Standing disclosure is independent of branch_policy deferral (#3314 / Greptile).
  pushCoverageCheckResumeDisclosure(lines, projectRoot);

  // #3214 / #3156: verify_tools is mutation readiness — always run, even under
  // rapid/minimal. Dial skipFatPath only lightens *ceremony* (triage welcome,
  // optional network, staleness tickler), never readiness gates.
  // Persist outcome into quick_steps so ritual-state records failure (not only
  // process exit) — re-arm / later readers must not see a green cold start.
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
    const toolsOutcome = verifyToolsFn((line) => lines.push(line));
    const durationMs = elapsedMs(stepStarted);
    const toolsOk = toolsOutcome.exitCode === 0;
    const toolsMessage = toolsOk
      ? "verify:tools ok"
      : `verify:tools failed (exit ${toolsOutcome.exitCode}); session not ready.`;
    if (!toolsOk) {
      lines.push(`[deft session] ${toolsMessage}`);
    }
    // Record on quick_steps (durable ritual-state) in addition to step timings.
    quickSteps.verify_tools = ritualStep({
      ok: toolsOk,
      ts: instant,
      message: toolsMessage,
      exitCode: toolsOutcome.exitCode,
      command: ["verify:tools"],
      durationMs,
    });
    stepTimings.push({ name: "verify_tools", duration_ms: durationMs });
  }

  // #3282 / #3286: orientation compression — compose doctor + toolchain preflight
  // (+ agents:refresh / cache-fresh deposit-sha fast-paths) as inline sections with
  // per-section status lines. Composition of existing steps, not a new monolith.
  // Read-only posture never reaches here (#2176). Dual-path Later (`deft orient`)
  // remains open — see orientation bundle.later.
  let toolchainPreflightResult: ToolchainPreflightResult | null = null;
  let orientationBundle: OrientationBundle | null = null;
  {
    const stepStarted = performance.now();
    if (options.orientation === null) {
      // Explicit skip (tests): still honour legacy preflight-only path when set.
      if (options.toolchainPreflight === null) {
        stepTimings.push({ name: "orientation", duration_ms: 0, skipped: true });
        stepTimings.push({ name: "toolchain_preflight", duration_ms: 0, skipped: true });
      } else if (options.toolchainPreflight !== undefined) {
        toolchainPreflightResult = options.toolchainPreflight;
        lines.push(...toolchainPreflightResult.lines);
        stepTimings.push({
          name: "toolchain_preflight",
          duration_ms: elapsedMs(stepStarted),
        });
      } else {
        stepTimings.push({ name: "orientation", duration_ms: 0, skipped: true });
      }
    } else if (options.orientation !== undefined) {
      orientationBundle = options.orientation;
      toolchainPreflightResult = orientationBundle.preflight;
      lines.push(...orientationBundle.lines);
      for (const section of orientationBundle.sections) {
        stepTimings.push({
          name: section.name,
          duration_ms: section.durationMs,
          ...(section.status === "skipped" ? { skipped: true } : {}),
        });
        // Record gated ritual steps so verify:session-ritual can skip re-runs.
        // Do not overwrite explicit --defer (deferred_reason) records.
        if (
          (section.name === "doctor" || section.name === "cache_fresh") &&
          !gatedSteps[section.name]?.deferred_reason
        ) {
          gatedSteps[section.name] = ritualStep({
            ok: section.ok,
            ts: instant,
            message: section.lines[0] ?? section.status,
            exitCode: section.exitCode,
            durationMs: section.durationMs,
            command: section.name === "doctor" ? ["doctor"] : ["verify:cache-fresh"],
          });
        }
      }
      stepTimings.push({ name: "orientation", duration_ms: elapsedMs(stepStarted) });
    } else {
      try {
        // Skip composed doctor/cache_fresh work when those gated steps are deferred.
        const doctorDeferred = Boolean(gatedSteps.doctor?.deferred_reason);
        const cacheDeferred = Boolean(gatedSteps.cache_fresh?.deferred_reason);
        orientationBundle = runOrientationCompression({
          projectRoot,
          frameworkRoot: options.frameworkRoot ?? projectRoot,
          compact: options.compact,
          env: options.env,
          now: instant,
          toolchainPreflight: options.toolchainPreflight,
          toolchainPreflightOptions: options.toolchainPreflightOptions,
          includeDoctor: !doctorDeferred,
          includeCacheFresh: !cacheDeferred,
          ...options.orientationOptions,
        });
        toolchainPreflightResult = orientationBundle.preflight;
        lines.push(...orientationBundle.lines);
        for (const section of orientationBundle.sections) {
          stepTimings.push({
            name: section.name,
            duration_ms: section.durationMs,
            ...(section.status === "skipped" ? { skipped: true } : {}),
          });
          if (
            (section.name === "doctor" || section.name === "cache_fresh") &&
            !gatedSteps[section.name]?.deferred_reason
          ) {
            gatedSteps[section.name] = ritualStep({
              ok: section.ok,
              ts: instant,
              message: section.lines[0] ?? section.status,
              exitCode: section.exitCode,
              durationMs: section.durationMs,
              command: section.name === "doctor" ? ["doctor"] : ["verify:cache-fresh"],
            });
          }
        }
        stepTimings.push({ name: "orientation", duration_ms: elapsedMs(stepStarted) });
      } catch {
        // fail-open: orientation composition must not abort session:start —
        // fall back to preflight-only (#3282).
        try {
          if (options.toolchainPreflight !== null) {
            toolchainPreflightResult =
              options.toolchainPreflight ??
              runToolchainPreflight({
                projectRoot,
                frameworkRoot: options.frameworkRoot ?? projectRoot,
                ...options.toolchainPreflightOptions,
              });
            lines.push(...toolchainPreflightResult.lines);
          }
        } catch {
          // ignore
        }
        stepTimings.push({ name: "orientation", duration_ms: elapsedMs(stepStarted) });
      }
    }
  }

  // #3214: rapid/minimal skip informational cold-path ceremony only.
  if (!quickSteps.triage_welcome && !skipFatPath) {
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
  // #3214: also skipped under rapid/minimal dial (lifecycleWrites light/minimal).
  if (allowOptionalNetwork && !skipFatPath) {
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
    if (!skipFatPath) {
      lines.push(OPTIONAL_NETWORK_SKIPPED_MESSAGE);
    }
  }

  if (!skipFatPath) {
    try {
      const tickler = (options.runStalenessTickler ?? maybeRunStalenessTickler)(projectRoot, {
        now: instant,
      });
      lines.push(...tickler.lines);
    } catch {
      // Staleness tickler is best-effort and must never block session start.
    }
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
  const persistedOccupancy = persistOccupancyOrDeny(projectRoot, options, instant, environment);
  if ("payload" in persistedOccupancy) {
    return persistedOccupancy;
  }
  const coldSessionId = persistedOccupancy.sessionId;
  const dialDict = {
    ...ceremonyDialToDict(ceremonyDialSelection),
    start_tier: ceremonyDialSelection.depth,
    start_tier_provenance: startTierProvenance,
    provisional: {
      taskSize: provisionalDial.taskSize,
      modelTier: provisionalDial.modelTier,
      projectShape: provisionalDial.projectShape,
      reasons: [...provisionalDial.reasons],
    },
    consumer_evidence: ceremonyDialEvidenceToDict(consumerDialEvidence),
  };
  const preflightDict =
    toolchainPreflightResult !== null ? toolchainPreflightToDict(toolchainPreflightResult) : null;
  const payload: Record<string, unknown> = {
    ...newRitualStatePayload({
      sessionId: coldSessionId,
      gitHead: gitHeadValue,
      worktreePath: worktreePath(projectRoot, runGit),
      startedAt: instant,
      quickSteps,
      gatedSteps,
    }),
    // #3214: record dial choice on ritual-state for audit / later re-arm context.
    ceremony_dial: dialDict,
    // #3282: durable preflight snapshot for harness / later check degraded mode.
    ...(preflightDict !== null ? { toolchain_preflight: preflightDict } : {}),
  };
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
  // verify_tools is recorded on quick_steps; failure makes ready=false.
  // #3282: toolchain preflight degraded mode does NOT flip ready=false by itself —
  // agents still proceed with a named skip report at check time.
  const code = failed.length > 0 ? 1 : 0;
  const totalMs = elapsedMs(overallStarted);

  // #3282 / #3286: event-driven run-summary (dial + preflight + orientation call
  // count for dual-path Later graduation trigger) — fail-open, silent when unset.
  if (options.emitRunSummary !== false) {
    try {
      const emitter = new RunSummaryEmitter({
        projectRoot,
        sessionId: coldSessionId,
        env: options.env,
      });
      emitter.emitSessionStart({
        ceremony_dial: dialDict,
        preflight: preflightDict ?? undefined,
        ceremony_tier: COLD_CEREMONY_TIER,
        ready: code === 0,
        exit_code: code,
        ...(orientationBundle !== null
          ? {
              orientation_call_count: orientationBundle.orientationCallCount,
              orientation_compact: orientationBundle.compact,
              deposit_sha: orientationBundle.depositSha,
              orientation_later_status: orientationBundle.later.status,
              orientation_sections: orientationBundle.sections.map((s) => ({
                name: s.name,
                status: s.status,
                ok: s.ok,
                sha_match: s.shaMatch,
              })),
            }
          : {}),
      });
      // #3399: emit a denominator only when a host/harness value is known.
      // Prefer DEFT_TOTAL_TOOL_TURNS (harness_actual), then DEFT_MAX_TURNS /
      // host maxTurns (host_planned). Unset → no event; share is unevaluable.
      emitter.emitSessionToolTurnDenominator(effortBudget.budget.maxTurns);
      // #3319: evaluate escalate-on-evidence only when #3274 is live. A pin
      // emits nothing so never-evaluated stays distinguishable from declined.
      if (!isCeremonyStartTierPinned(startTierProvenance)) {
        emitCeremonyDialEscalationEvaluation({
          projectRoot,
          sessionId: coldSessionId,
          env: options.env,
          evaluation: evaluateSessionStartCeremonyDialEscalation({
            selection: ceremonyDialSelection,
          }),
        });
      }
    } catch {
      // fail-open
    }
  }

  // #3117: bind live deposit generation when payload surfaces load (cold path).
  let freshnessBind: Record<string, unknown> | null = null;
  try {
    const bound = bindSessionGeneration(projectRoot, {
      sessionId: coldSessionId,
      nowIso: timestampIso(instant),
      payloadLoaded: true,
    });
    freshnessBind = {
      bound_generation: bound.bound.boundGeneration,
      live_generation: bound.live.generation,
      content_version: bound.live.contentVersion,
      path: bound.path,
    };
    lines.push(
      `[deft freshness] bound generation ${bound.bound.boundGeneration} ` +
        `(live deposit v${bound.live.contentVersion})`,
    );
    lines.push(
      `[deft freshness] set DEFT_SESSION_ID=${coldSessionId} for bare freshness:report/bind ` +
        `(or pass --session-id; required for multi-agent trusted readiness)`,
    );
  } catch {
    const live = readLiveGeneration(projectRoot);
    if (live !== null) {
      lines.push(
        `[deft freshness] live generation ${live.generation} present; session bind deferred ` +
          `(run \`deft freshness:bind\` after loading payload surfaces)`,
      );
    }
  }

  const resultPayload = {
    ready: code === 0,
    exit_code: code,
    ceremony_tier: COLD_CEREMONY_TIER,
    ceremony_dial: dialDict,
    ...(preflightDict !== null ? { toolchain_preflight: preflightDict } : {}),
    ...(orientationBundle !== null
      ? {
          orientation: {
            deposit_sha: orientationBundle.depositSha,
            compact: orientationBundle.compact,
            call_count: orientationBundle.orientationCallCount,
            later: orientationBundle.later,
            sections: orientationBundle.sections.map((s) => ({
              name: s.name,
              status: s.status,
              ok: s.ok,
              sha_match: s.shaMatch,
              exit_code: s.exitCode,
            })),
          },
        }
      : {}),
    state_path: statePath,
    ...(freshnessBind ? { freshness: freshnessBind } : {}),
    quick_steps: quickSteps,
    gated_steps: gatedSteps,
    steps: stepTimings,
    duration_ms: totalMs,
    optional_network: allowOptionalNetwork && !skipFatPath,
    user_md: {
      path: userMd.path,
      rung: userMd.rung,
      found: userMd.found,
      diagnostic: userMd.diagnostic,
    },
    environment: environmentContextToDict(environment),
    scm: scmReadinessToDict(scm),
    host_content_surface: hostContentSurfaceToDict(hostSurface.report),
    effort_budget: effortBudgetToDict(effortBudget.budget),
    occupancy: {
      action: persistedOccupancy.action,
      session_id: coldSessionId,
    },
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
  // #3508: operator-visible CLI process time. ⊗ not #3286 Later graduation input.
  if (!resolveSessionCompact({ compact: options.compact, env: options.env })) {
    lines.push(formatSessionStartCeremonyCostLine(COLD_CEREMONY_TIER, totalMs));
  }
  return { code, payload: resultPayload, lines };
}

export { ritualStatePath };
