import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readCorePackageVersion } from "../engine-version.js";
import { hasArtifactSuffix } from "../layout/resolve.js";
import { readPlanSequence } from "../plan-sequence/store.js";
import { formatFrameworkCommand } from "../render/framework-commands.js";
import {
  type ActiveCliCheckResult,
  type ActiveCliCheckSeams,
  checkActiveCliAgainstTarget,
} from "./active-cli.js";
import { defaultGitRunner, type GitRunner, gitHead, gitIsAncestor, worktreePath } from "./git.js";
import { pythonJsonDump } from "./json.js";
import {
  type DirectivePosture,
  ENV_SESSION_POSTURE,
  readOnlyPostureMessage,
  resolveSessionPosture,
  ritualStateIsPostureAuthority,
} from "./posture.js";
import { defaultRitualRunner } from "./ritual-entrypoint.js";
import {
  type RitualState,
  readRitualState,
  ritualStateMarksRearmNeeded,
  ritualStatePath,
  ritualStep,
  writeRitualState,
} from "./ritual-sentinel.js";
import {
  formatSessionStartRecoveryCommand,
  GATED_STEPS,
  type GatedStepName,
  QUICK_STEPS,
  type SessionCeremonyTier,
} from "./session-start.js";
import { resolveSessionRitualStalenessHours } from "./staleness.js";

export {
  formatCacheFetchAllRecoveryCommand,
  recoveryHintForStaleFailure,
} from "./cache-recovery.js";
export const ENV_SKIP = "DEFT_SESSION_RITUAL_SKIP";
export {
  ENTRYPOINT_TIMEOUT_EXIT_CODE,
  ENTRYPOINT_TIMEOUT_SECONDS,
} from "./ritual-entrypoint.js";

export const GATED_ENTRYPOINT_COMMANDS: Readonly<Record<GatedStepName, readonly string[]>> = {
  agent_hooks: ["verify:hooks-installed", "--scope=agent", "--live"],
  doctor: ["doctor"],
  cache_fresh: ["verify:cache-fresh"],
};

/** Explicit skip flag threaded through the gated `cache_fresh` argv (#3507). */
export const SKIP_DRIFT_PROBE_FLAG = "--skip-drift-probe";
/** Explicit work-selection flag threaded through the gated `cache_fresh` argv (#3507). */
export const WORK_SELECTION_FLAG = "--work-selection";
/** Distinct ritual-state field — never `deferred_reason` (#3507). */
export const DRIFT_PROBE_SKIPPED_NO_WORK_SELECTION = "skipped-no-work-selection";

export type WorkSelectionKind =
  | "none"
  | "active-story"
  | "triage-queue"
  | "ordered-plan"
  | "for-issue"
  | "explicit-flag";

export interface WorkSelectionSignal {
  readonly inPlay: boolean;
  readonly kind: WorkSelectionKind;
}

export type DetectWorkSelection = (projectRoot: string) => WorkSelectionSignal;

function hasActiveStoryArtifact(projectRoot: string): boolean {
  for (const dirName of ["xbrief", "vbrief"] as const) {
    const activeDir = join(projectRoot, dirName, "active");
    try {
      for (const entry of readdirSync(activeDir, { withFileTypes: true })) {
        if (entry.isFile() && hasArtifactSuffix(entry.name)) return true;
      }
    } catch {
      /* missing or unreadable active folder is not work selection */
    }
  }
  return false;
}

function hasUnexhaustedPlanSequence(projectRoot: string): WorkSelectionKind | null {
  try {
    const sequence = readPlanSequence(projectRoot);
    if (sequence === null || sequence.exhausted === true) return null;
    return sequence.sequence_kind === "triage" ? "triage-queue" : "ordered-plan";
  } catch {
    return null;
  }
}

/**
 * Default work-selection detector for the gated `cache_fresh` seam (#3507).
 * Active story xBRIEF (scope:activate residue), unexhausted ordered-plan /
 * triage sequence. `--for-issue` is a positive evaluate override, not this
 * detector — the gated argv never carries it.
 */
export function detectWorkSelection(projectRoot: string): WorkSelectionSignal {
  if (hasActiveStoryArtifact(projectRoot)) {
    return { inPlay: true, kind: "active-story" };
  }
  const planKind = hasUnexhaustedPlanSequence(projectRoot);
  if (planKind !== null) {
    return { inPlay: true, kind: planKind };
  }
  return { inPlay: false, kind: "none" };
}

export function resolveGatedEntrypointCommand(
  stepName: GatedStepName,
  projectRoot: string,
  detect: DetectWorkSelection = detectWorkSelection,
): string[] {
  const base = [...GATED_ENTRYPOINT_COMMANDS[stepName]];
  if (stepName !== "cache_fresh") return base;
  const selection = detect(projectRoot);
  if (selection.inPlay) {
    return [...base, WORK_SELECTION_FLAG];
  }
  return [...base, SKIP_DRIFT_PROBE_FLAG];
}

export interface VerifyResult {
  readonly code: number;
  readonly message: string;
  readonly tier: string;
  readonly statePath: string;
  readonly bypassed: boolean;
  readonly wouldFailCode: number | null;
  readonly posture: DirectivePosture;
  readonly ritualStateRequired: boolean;
  /**
   * Preferred session:start recovery when code !== 0 (#2992).
   * `rearm` when age/compact stale on an otherwise valid bind; `cold` otherwise.
   */
  readonly recoveryTier?: SessionCeremonyTier | null;
}

export type RitualRunner = (
  command: readonly string[],
  projectRoot: string,
) => {
  code: number;
  stdout: string;
  stderr: string;
};

function truthy(raw: string | undefined): boolean {
  return new Set(["1", "true", "yes", "on"]).has((raw ?? "").trim().toLowerCase());
}

function stepPasses(step: Record<string, unknown> | undefined | null): boolean {
  if (!step || typeof step !== "object") return false;
  if (step.deferred_reason) return true;
  // `drift_probe` is a distinct diagnostic; it must never satisfy a step (#3507).
  return step.ok === true;
}

function failedStepMessage(
  tierName: string,
  stepName: string,
  step: Record<string, unknown> | undefined,
): string {
  const coldCmd = formatSessionStartRecoveryCommand("cold");
  if (step === undefined) {
    return (
      `session ritual ${tierName} step '${stepName}' is missing. ` +
      `Run \`${coldCmd}\` before implementation dispatch.`
    );
  }
  const message = step.message;
  const suffix = typeof message === "string" && message.length > 0 ? `: ${message}` : "";
  return `session ritual ${tierName} step '${stepName}' failed${suffix}`;
}

/** Human recovery line after a failed ritual probe (#2992 / #2993). */
export function formatRitualRecoveryInstruction(tier: SessionCeremonyTier = "cold"): string {
  const ready = formatFrameworkCommand(["session:ready"]);
  const start = formatSessionStartRecoveryCommand(tier);
  const verify = formatFrameworkCommand(["verify:session-ritual", "--", "--tier=gated"]);
  if (tier === "rearm") {
    return (
      `Recovery: run ${ready} (one-shot), or ${start} ` +
      `(or full ${formatSessionStartRecoveryCommand("cold")} if worktree/HEAD changed), ` +
      `then ${verify}.`
    );
  }
  return (
    `Recovery: run ${ready} ` +
    `(one-shot: session:start + gated ritual + cache recovery as needed).`
  );
}

/**
 * Sanctioned audited defer copy for gated `cache_fresh` failure (#3506 / #3507).
 * Independent of the #3507 work-selection argv seam — defer is still the
 * operator-audited escape, not the drift-probe skip.
 */
export function formatCacheFreshDeferSoftPath(): string {
  const cmd = formatFrameworkCommand(["session:start", "--", "--defer", "cache_fresh=<reason>"]);
  return `Soft path (audited): \`${cmd}\`.`;
}

function applyCacheFreshDriftProbeField(
  payload: Record<string, unknown>,
  command: readonly string[],
): void {
  if (command.includes(SKIP_DRIFT_PROBE_FLAG)) {
    payload.drift_probe = DRIFT_PROBE_SKIPPED_NO_WORK_SELECTION;
    return;
  }
  if (payload.drift_probe === DRIFT_PROBE_SKIPPED_NO_WORK_SELECTION) {
    delete payload.drift_probe;
  }
}

function shouldRearmDriftProbe(
  payload: Record<string, unknown>,
  projectRoot: string,
  detect: DetectWorkSelection,
): boolean {
  if (payload.drift_probe !== DRIFT_PROBE_SKIPPED_NO_WORK_SELECTION) return false;
  return detect(projectRoot).inPlay;
}

function runGatedStep(
  projectRoot: string,
  payload: Record<string, unknown>,
  stepName: GatedStepName,
  runner: RitualRunner,
  now: Date,
  detect: DetectWorkSelection = detectWorkSelection,
): string | null {
  const command = resolveGatedEntrypointCommand(stepName, projectRoot, detect);
  const { code, stdout, stderr } = runner(command, projectRoot);
  const message = stdout.trim() || stderr.trim() || `${command[0] as string} exited ${code}`;
  const gated = (payload.gated_steps as Record<string, Record<string, unknown>> | undefined) ?? {};
  gated[stepName] = ritualStep({
    ok: code === 0,
    ts: now,
    exitCode: code,
    message,
    command,
  });
  payload.gated_steps = gated;
  if (stepName === "cache_fresh") {
    applyCacheFreshDriftProbeField(payload, command);
  }
  try {
    writeRitualState(projectRoot, payload);
  } catch (exc) {
    return `could not write session ritual state after ${stepName}: ${String(exc)}`;
  }
  return null;
}

function headDriftRecoveryMessage(): string {
  const coldCmd = formatSessionStartRecoveryCommand("cold");
  return (
    `session ritual state is stale because git HEAD changed discontinuously. ` +
    `Run \`${coldCmd}\` again (full cold ceremony required).`
  );
}

type EvaluateLoadedResult = {
  code: number;
  message: string;
  recoveryTier: SessionCeremonyTier | null;
};

function evaluateLoadedState(
  projectRoot: string,
  state: RitualState,
  input: { tier: string; now: Date; runGit?: GitRunner; rebindForwardHead?: boolean },
): EvaluateLoadedResult {
  const runGit = input.runGit ?? defaultGitRunner;
  const coldCmd = formatSessionStartRecoveryCommand("cold");
  const rearmCmd = formatSessionStartRecoveryCommand("rearm");
  const { head: currentHead, error: headError } = gitHead(projectRoot, runGit);
  if (currentHead === null) {
    return {
      code: 2,
      message: headError ?? "could not resolve git HEAD",
      recoveryTier: "cold",
    };
  }
  const currentWorktree = worktreePath(projectRoot, runGit);
  if (state.worktreePath !== currentWorktree) {
    return {
      code: 1,
      message:
        `session ritual state belongs to a different worktree (${state.worktreePath}); ` +
        `run \`${coldCmd}\` here (full cold ceremony required).`,
      recoveryTier: "cold",
    };
  }
  if (state.gitHead !== currentHead) {
    const forward = gitIsAncestor(projectRoot, state.gitHead, currentHead, runGit);
    if (forward === null) {
      return {
        code: 2,
        message: "could not verify git history for session ritual",
        recoveryTier: "cold",
      };
    }
    if (!forward) {
      return { code: 1, message: headDriftRecoveryMessage(), recoveryTier: "cold" };
    }
    if (input.rebindForwardHead) {
      const payload = { ...state.raw, git_head: currentHead };
      try {
        writeRitualState(projectRoot, payload);
      } catch (exc) {
        return {
          code: 2,
          message: `could not rebind session ritual git HEAD: ${String(exc)}`,
          recoveryTier: "cold",
        };
      }
    }
  }
  const staleness = resolveSessionRitualStalenessHours(projectRoot);
  if (staleness.source === "default-on-error") {
    return {
      code: 2,
      message: staleness.error ?? "session ritual staleness policy is invalid",
      recoveryTier: "cold",
    };
  }
  const maxAgeMs = staleness.hours * 60 * 60 * 1000;
  if (input.now.getTime() - state.startedAt.getTime() > maxAgeMs) {
    // Age / compact stale on same worktree + continuous HEAD → prefer re-arm (#2992).
    // compact_resume_at / rearm_needed amplify the same recovery path.
    const compactNote = ritualStateMarksRearmNeeded(state)
      ? " Compact/resume marked re-arm needed."
      : "";
    return {
      code: 1,
      message:
        `session ritual state is stale (older than ${staleness.hours}h).${compactNote} ` +
        `Run \`${rearmCmd}\` to re-arm (or \`${coldCmd}\` for a full cold ceremony).`,
      recoveryTier: "rearm",
    };
  }
  for (const stepName of QUICK_STEPS) {
    const step = state.quickSteps[stepName];
    if (!stepPasses(step)) {
      return {
        code: 1,
        message: failedStepMessage("quick", stepName, step),
        recoveryTier: "cold",
      };
    }
  }
  if (input.tier === "gated") {
    for (const stepName of GATED_STEPS) {
      const step = state.gatedSteps[stepName];
      if (!stepPasses(step)) {
        return {
          code: 1,
          message: failedStepMessage("gated", stepName, step),
          recoveryTier: "cold",
        };
      }
    }
  }
  return {
    code: 0,
    message: `OK session ritual ${input.tier} tier is fresh.`,
    recoveryTier: null,
  };
}

export interface VerifySessionRitualOptions {
  readonly tier?: "quick" | "gated";
  readonly now?: Date;
  readonly runner?: RitualRunner;
  readonly bypass?: boolean;
  readonly envSkip?: string | undefined;
  readonly runGit?: GitRunner;
  readonly posture?: DirectivePosture;
  readonly envPosture?: string | undefined;
  readonly handoffText?: string | null;
  /** Re-run selected gated prerequisites even when their recorded step is green. */
  readonly forceGatedSteps?: readonly GatedStepName[];
  /**
   * #3233: engine version the post-upgrade / ritual check must match on the
   * shell-active CLI. When null/omitted, still fail closed on multi-prefix
   * version skew (active older than another PATH candidate).
   */
  readonly targetEngineVersion?: string | null;
  /** Injectable active-CLI seams for hermetic tests (#3233). */
  readonly activeCliSeams?: ActiveCliCheckSeams;
  /**
   * Override the active-CLI probe entirely (tests). Defaults to
   * {@link checkActiveCliAgainstTarget}.
   */
  readonly checkActiveCli?: (
    targetVersion: string | null,
    seams?: ActiveCliCheckSeams,
  ) => ActiveCliCheckResult;
  /** Injectable work-selection detector for gated `cache_fresh` (#3507). */
  readonly detectWorkSelection?: DetectWorkSelection;
}

export interface InspectSessionRitualOptions {
  readonly tier?: "quick" | "gated";
  readonly now?: Date;
  readonly runGit?: GitRunner;
  readonly posture?: DirectivePosture;
  readonly envPosture?: string | undefined;
  readonly handoffText?: string | null;
}

/**
 * Read-only ritual-state inspection for host hooks.
 *
 * Unlike {@link verifySessionRitual}, this never runs missing gated entrypoints
 * and never rewrites `.deft/ritual-state.json`. A PreToolUse decision must be a
 * probe, not a hidden `doctor` / cache-refresh mutation boundary.
 */
export function inspectSessionRitual(
  projectRoot: string,
  options: InspectSessionRitualOptions = {},
): VerifyResult {
  const tier = options.tier ?? "quick";
  const posture = resolveSessionPosture({
    explicitPosture: options.posture ?? null,
    envPosture: options.envPosture ?? process.env.DEFT_SESSION_POSTURE,
    handoffText: options.handoffText,
    tier,
  });
  const ritualStateRequired = posture === "mutation" && !ritualStateIsPostureAuthority();
  const statePath = ritualStatePath(projectRoot);

  if (posture === "read-only") {
    return {
      code: 0,
      message: readOnlyPostureMessage(tier),
      tier,
      statePath,
      bypassed: false,
      wouldFailCode: null,
      posture,
      ritualStateRequired: false,
    };
  }

  const missingStateFile = !existsSync(statePath);
  const [state, err] = readRitualState(projectRoot);
  if (state === null) {
    const code = missingStateFile ? 1 : 2;
    const startCommand = formatSessionStartRecoveryCommand("cold");
    return {
      code,
      message:
        code === 1
          ? `${err}. Run \`${startCommand}\` before implementation dispatch.`
          : (err ?? "ritual state invalid"),
      tier,
      statePath,
      bypassed: false,
      wouldFailCode: null,
      posture,
      ritualStateRequired,
      recoveryTier: "cold",
    };
  }

  const evaluated = evaluateLoadedState(projectRoot, state, {
    tier,
    now: options.now ?? new Date(),
    runGit: options.runGit,
    rebindForwardHead: false,
  });
  return {
    code: evaluated.code,
    message: evaluated.message,
    tier,
    statePath,
    bypassed: false,
    wouldFailCode: null,
    posture,
    ritualStateRequired,
    recoveryTier: evaluated.recoveryTier,
  };
}

export function verifySessionRitual(
  projectRoot: string,
  options: VerifySessionRitualOptions = {},
): VerifyResult {
  const tier = options.tier ?? "quick";
  const posture = resolveSessionPosture({
    explicitPosture: options.posture ?? null,
    envPosture: options.envPosture ?? process.env.DEFT_SESSION_POSTURE,
    handoffText: options.handoffText,
    tier,
  });
  // Satisfy static analysis / keep ENV_SESSION_POSTURE as the public constant name.
  void ENV_SESSION_POSTURE;
  const ritualStateRequired = posture === "mutation" && !ritualStateIsPostureAuthority();
  if (tier !== "quick" && tier !== "gated") {
    return {
      code: 2,
      message: `tier must be 'quick' or 'gated', got ${JSON.stringify(tier)}`,
      tier,
      statePath: ritualStatePath(projectRoot),
      bypassed: false,
      wouldFailCode: null,
      posture,
      ritualStateRequired,
    };
  }
  const instant = options.now ?? new Date();
  const envSkip = options.envSkip ?? process.env.DEFT_SESSION_RITUAL_SKIP;
  const isBypassed = options.bypass ?? truthy(envSkip);
  const statePath = ritualStatePath(projectRoot);
  const missingStateFile = !existsSync(statePath);

  // Read-only posture never treats ritual-state as authority — including when
  // DEFT_SESSION_RITUAL_SKIP is set. Skip is only for mutation-boundary gates.
  if (posture === "read-only") {
    return {
      code: 0,
      message: readOnlyPostureMessage(tier),
      tier,
      statePath,
      bypassed: false,
      wouldFailCode: null,
      posture,
      ritualStateRequired: false,
    };
  }

  let [state, err] = readRitualState(projectRoot);
  if (state === null) {
    const code = missingStateFile ? 1 : 2;
    const startCommand = formatSessionStartRecoveryCommand("cold");
    const message =
      code === 1
        ? `${err}. Run \`${startCommand}\` before implementation dispatch.`
        : (err ?? "ritual state invalid");
    if (isBypassed) {
      return {
        code: 0,
        message,
        tier,
        statePath,
        bypassed: true,
        wouldFailCode: code,
        posture,
        ritualStateRequired,
        recoveryTier: "cold",
      };
    }
    return {
      code,
      message,
      tier,
      statePath,
      bypassed: false,
      wouldFailCode: null,
      posture,
      ritualStateRequired,
      recoveryTier: "cold",
    };
  }

  if (tier === "gated" && !isBypassed) {
    const precheck = evaluateLoadedState(projectRoot, state, {
      tier: "quick",
      now: instant,
      runGit: options.runGit,
      rebindForwardHead: true,
    });
    if (precheck.code !== 0) {
      return {
        code: precheck.code,
        message: precheck.message,
        tier,
        statePath,
        bypassed: false,
        wouldFailCode: null,
        posture,
        ritualStateRequired,
        recoveryTier: precheck.recoveryTier,
      };
    }

    const reloadedAfterPrecheck = readRitualState(projectRoot);
    state = reloadedAfterPrecheck[0];
    err = reloadedAfterPrecheck[1];
    if (state === null) {
      return {
        code: 2,
        message: err ?? "ritual state invalid after precheck",
        tier,
        statePath,
        bypassed: false,
        wouldFailCode: null,
        posture,
        ritualStateRequired,
      };
    }

    const payload = { ...state.raw };
    const gated = { ...(payload.gated_steps as Record<string, Record<string, unknown>>) };
    payload.gated_steps = gated;
    const runCmd = options.runner ?? defaultRitualRunner;
    const forced = new Set<GatedStepName>(options.forceGatedSteps ?? []);
    const detect = options.detectWorkSelection ?? detectWorkSelection;
    for (const stepName of GATED_STEPS) {
      const step = gated[stepName];
      if (step?.deferred_reason && stepName !== "agent_hooks") continue;
      // Hook readiness is a live mutation prerequisite, not a cacheable doctor
      // result. Re-run it at every gated boundary so registration/shim drift
      // cannot remain hidden behind an earlier green ritual record.
      const rearmDrift =
        stepName === "cache_fresh" && shouldRearmDriftProbe(payload, projectRoot, detect);
      if (stepName !== "agent_hooks" && stepPasses(step) && !forced.has(stepName) && !rearmDrift) {
        continue;
      }
      const writeError = runGatedStep(projectRoot, payload, stepName, runCmd, instant, detect);
      if (writeError !== null) {
        return {
          code: 2,
          message: writeError,
          tier,
          statePath,
          bypassed: false,
          wouldFailCode: null,
          posture,
          ritualStateRequired,
        };
      }
    }
    const reloaded = readRitualState(projectRoot);
    state = reloaded[0];
    err = reloaded[1];
    if (state === null) {
      return {
        code: 2,
        message: err ?? "ritual state invalid after gated update",
        tier,
        statePath,
        bypassed: false,
        wouldFailCode: null,
        posture,
        ritualStateRequired,
      };
    }

    // #3233: after gated entrypoints, verify the shell-active deft/directive
    // is not a stale higher-precedence shadow of a multi-prefix install.
    // Independent target = explicit option, else in-process publishable engine
    // (never the active CLI's own version — see resolveDefaultActiveCliTarget).
    const targetEngineVersion = options.targetEngineVersion ?? null;
    const checkActiveCli = options.checkActiveCli ?? checkActiveCliAgainstTarget;
    let inProcessVersion: string | null = null;
    try {
      inProcessVersion = readCorePackageVersion();
    } catch {
      inProcessVersion = null;
    }
    const activeCliSeams: ActiveCliCheckSeams = {
      inProcessVersion,
      ...options.activeCliSeams,
    };
    const activeCli = checkActiveCli(targetEngineVersion, activeCliSeams);
    if (!activeCli.ok) {
      return {
        code: activeCli.code === 0 ? 1 : activeCli.code,
        message: activeCli.lines.length > 0 ? activeCli.lines.join("\n") : activeCli.message,
        tier,
        statePath,
        bypassed: false,
        wouldFailCode: null,
        posture,
        ritualStateRequired,
        recoveryTier: "cold",
      };
    }
  }

  const evaluated = evaluateLoadedState(projectRoot, state, {
    tier,
    now: instant,
    runGit: options.runGit,
    rebindForwardHead: true,
  });
  if (isBypassed) {
    return {
      code: 0,
      message: evaluated.message,
      tier,
      statePath,
      bypassed: true,
      wouldFailCode: evaluated.code === 0 ? null : evaluated.code,
      posture,
      ritualStateRequired,
      recoveryTier: evaluated.recoveryTier,
    };
  }
  return {
    code: evaluated.code,
    message: evaluated.message,
    tier,
    statePath,
    bypassed: false,
    wouldFailCode: null,
    posture,
    ritualStateRequired,
    recoveryTier: evaluated.recoveryTier,
  };
}

export function emitVerifyJson(result: VerifyResult): string {
  return pythonJsonDump({
    ready: result.code === 0,
    exit_code: result.code,
    tier: result.tier,
    message: result.message,
    state_path: result.statePath,
    bypassed: result.bypassed,
    would_fail_code: result.wouldFailCode,
    posture: result.posture,
    ritual_state_required: result.ritualStateRequired,
    recovery_tier: result.recoveryTier ?? null,
  });
}

export function emitBypassWarning(result: VerifyResult): string {
  if (result.bypassed && result.wouldFailCode !== null) {
    return `[deft] WARNING: ${ENV_SKIP}=1 bypassed a session ritual failure (${result.message})`;
  }
  return "";
}
