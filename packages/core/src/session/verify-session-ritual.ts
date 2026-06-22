import { existsSync } from "node:fs";
import { formatFrameworkCommand } from "../render/framework-commands.js";
import { defaultGitRunner, type GitRunner, gitHead, worktreePath } from "./git.js";
import { pythonJsonDump } from "./json.js";
import { defaultRitualRunner } from "./ritual-entrypoint.js";
import {
  type RitualState,
  readRitualState,
  ritualStatePath,
  ritualStep,
  writeRitualState,
} from "./ritual-sentinel.js";
import { GATED_STEPS, QUICK_STEPS } from "./session-start.js";
import { resolveSessionRitualStalenessHours } from "./staleness.js";

export const ENV_SKIP = "DEFT_SESSION_RITUAL_SKIP";
export {
  ENTRYPOINT_TIMEOUT_EXIT_CODE,
  ENTRYPOINT_TIMEOUT_SECONDS,
} from "./ritual-entrypoint.js";

export const GATED_ENTRYPOINT_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  doctor: ["doctor"],
  cache_fresh: ["verify:cache-fresh"],
};

export interface VerifyResult {
  readonly code: number;
  readonly message: string;
  readonly tier: string;
  readonly statePath: string;
  readonly bypassed: boolean;
  readonly wouldFailCode: number | null;
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
  return step.ok === true;
}

function failedStepMessage(tierName: string, stepName: string, step: unknown): string {
  if (step === null || step === undefined) {
    return (
      `session ritual ${tierName} step '${stepName}' is missing. ` +
      `Run \`${formatFrameworkCommand(["session:start"])}\` before implementation dispatch.`
    );
  }
  if (
    typeof step === "object" &&
    step !== null &&
    (step as Record<string, unknown>).deferred_reason
  ) {
    return "";
  }
  const message =
    typeof step === "object" && step !== null ? (step as Record<string, unknown>).message : null;
  const suffix = typeof message === "string" && message.length > 0 ? `: ${message}` : "";
  return `session ritual ${tierName} step '${stepName}' failed${suffix}`;
}

function runGatedStep(
  projectRoot: string,
  payload: Record<string, unknown>,
  stepName: string,
  runner: RitualRunner,
  now: Date,
): string | null {
  const command = [...(GATED_ENTRYPOINT_COMMANDS[stepName] ?? [])];
  const { code, stdout, stderr } = runner(command, projectRoot);
  const message = stdout.trim() || stderr.trim() || `${command[0] ?? stepName} exited ${code}`;
  const gated = (payload.gated_steps as Record<string, Record<string, unknown>> | undefined) ?? {};
  gated[stepName] = ritualStep({
    ok: code === 0,
    ts: now,
    exitCode: code,
    message,
    command,
  });
  payload.gated_steps = gated;
  try {
    writeRitualState(projectRoot, payload);
  } catch (exc) {
    return `could not write session ritual state after ${stepName}: ${String(exc)}`;
  }
  return null;
}

function evaluateLoadedState(
  projectRoot: string,
  state: RitualState,
  input: { tier: string; now: Date; runGit?: GitRunner },
): [number, string] {
  const runGit = input.runGit ?? defaultGitRunner;
  const { head: currentHead, error: headError } = gitHead(projectRoot, runGit);
  if (currentHead === null) {
    return [2, headError ?? "could not resolve git HEAD"];
  }
  const currentWorktree = worktreePath(projectRoot, runGit);
  if (state.worktreePath !== currentWorktree) {
    return [
      1,
      `session ritual state belongs to a different worktree (${state.worktreePath}); run \`${formatFrameworkCommand(["session:start"])}\` here.`,
    ];
  }
  if (state.gitHead !== currentHead) {
    return [
      1,
      `session ritual state is stale because git HEAD changed. Run \`${formatFrameworkCommand(["session:start"])}\` again.`,
    ];
  }
  const staleness = resolveSessionRitualStalenessHours(projectRoot);
  if (staleness.source === "default-on-error") {
    return [2, staleness.error ?? "session ritual staleness policy is invalid"];
  }
  const maxAgeMs = staleness.hours * 60 * 60 * 1000;
  if (input.now.getTime() - state.startedAt.getTime() > maxAgeMs) {
    const startCommand = formatFrameworkCommand(["session:start"]);
    return [
      1,
      `session ritual state is stale (older than ${staleness.hours}h). Run \`${startCommand}\` again.`,
    ];
  }
  for (const stepName of QUICK_STEPS) {
    const step = state.quickSteps[stepName];
    if (!stepPasses(step)) {
      return [1, failedStepMessage("quick", stepName, step)];
    }
  }
  if (input.tier === "gated") {
    for (const stepName of GATED_STEPS) {
      const step = state.gatedSteps[stepName];
      if (!stepPasses(step)) {
        return [1, failedStepMessage("gated", stepName, step)];
      }
    }
  }
  return [0, `OK session ritual ${input.tier} tier is fresh.`];
}

export interface VerifySessionRitualOptions {
  readonly tier?: "quick" | "gated";
  readonly now?: Date;
  readonly runner?: RitualRunner;
  readonly bypass?: boolean;
  readonly envSkip?: string | undefined;
  readonly runGit?: GitRunner;
}

export function verifySessionRitual(
  projectRoot: string,
  options: VerifySessionRitualOptions = {},
): VerifyResult {
  const tier = options.tier ?? "quick";
  if (tier !== "quick" && tier !== "gated") {
    return {
      code: 2,
      message: `tier must be 'quick' or 'gated', got ${JSON.stringify(tier)}`,
      tier,
      statePath: ritualStatePath(projectRoot),
      bypassed: false,
      wouldFailCode: null,
    };
  }
  const instant = options.now ?? new Date();
  const envSkip = options.envSkip ?? process.env[ENV_SKIP];
  const isBypassed = options.bypass ?? truthy(envSkip);
  const statePath = ritualStatePath(projectRoot);
  const missingStateFile = !existsSync(statePath);
  let [state, err] = readRitualState(projectRoot);
  if (state === null) {
    const code = missingStateFile ? 1 : 2;
    const startCommand = formatFrameworkCommand(["session:start"]);
    const message =
      code === 1
        ? `${err}. Run \`${startCommand}\` before implementation dispatch.`
        : (err ?? "ritual state invalid");
    if (isBypassed) {
      return { code: 0, message, tier, statePath, bypassed: true, wouldFailCode: code };
    }
    return { code, message, tier, statePath, bypassed: false, wouldFailCode: null };
  }

  if (tier === "gated" && !isBypassed) {
    const [precheckCode, precheckMessage] = evaluateLoadedState(projectRoot, state, {
      tier: "quick",
      now: instant,
      runGit: options.runGit,
    });
    if (precheckCode !== 0) {
      return {
        code: precheckCode,
        message: precheckMessage,
        tier,
        statePath,
        bypassed: false,
        wouldFailCode: null,
      };
    }

    const payload = { ...state.raw };
    const gated = { ...(payload.gated_steps as Record<string, Record<string, unknown>>) };
    payload.gated_steps = gated;
    const runCmd = options.runner ?? defaultRitualRunner;
    for (const stepName of GATED_STEPS) {
      const step = gated[stepName];
      if (step?.deferred_reason) continue;
      if (stepPasses(step)) continue;
      const writeError = runGatedStep(projectRoot, payload, stepName, runCmd, instant);
      if (writeError !== null) {
        return {
          code: 2,
          message: writeError,
          tier,
          statePath,
          bypassed: false,
          wouldFailCode: null,
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
      };
    }
  }

  const [code, message] = evaluateLoadedState(projectRoot, state, {
    tier,
    now: instant,
    runGit: options.runGit,
  });
  if (isBypassed) {
    return {
      code: 0,
      message,
      tier,
      statePath,
      bypassed: true,
      wouldFailCode: code === 0 ? null : code,
    };
  }
  return { code, message, tier, statePath, bypassed: false, wouldFailCode: null };
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
  });
}

export function emitBypassWarning(result: VerifyResult): string {
  if (result.bypassed && result.wouldFailCode !== null) {
    return `[deft] WARNING: ${ENV_SKIP}=1 bypassed a session ritual failure (${result.message})`;
  }
  return "";
}
