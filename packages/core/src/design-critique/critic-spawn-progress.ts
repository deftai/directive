/**
 * Critic-spawn progress gate + termination boundary (#5478 Prefer-A).
 *
 * Applies to Critic spawn (pointer envelope), not evaluateN3LaunchProbe
 * (#4432 launchability only). Adjacent to #5492 argv-ceiling docs — do not
 * collapse argv-too-long empty exit with this post-pointer 0-byte hang class.
 */

import { spawnSync } from "node:child_process";

export const CRITIC_SPAWN_PROGRESS_HALT = "dispatch-fail" as const;

export type CriticSpawnStdinMode = "ignore" | "fd" | "pipe" | "inherit" | "other";

export type CriticSpawnOutFdKind = "integer" | "write-stream-null-fd" | "other";

export type CriticSpawnHygieneInput = {
  /** Parent keeps the log outFd open until the child exits. */
  readonly outFdHeldUntilExit: boolean;
  readonly detached: boolean;
  readonly unref: boolean;
  readonly stdin: CriticSpawnStdinMode;
  /** Parent awaits child exit (does not fire-and-forget). */
  readonly parentWaitsOnChild: boolean;
  readonly outFdKind: CriticSpawnOutFdKind;
};

export type CriticSpawnHygieneCode = "hygiene-violation";

export type CriticSpawnHygieneVerdict =
  | { ok: true }
  | { ok: false; code: CriticSpawnHygieneCode; reasons: readonly string[] };

/**
 * Claude Critic-spawn hygiene MUST (#5478 Prefer-A bind map item 2).
 * Refuse detached+unref, null-fd WriteStream, open stdin, and fire-and-forget.
 */
export function evaluateCriticSpawnHygiene(
  input: CriticSpawnHygieneInput,
): CriticSpawnHygieneVerdict {
  const reasons: string[] = [];
  if (!input.outFdHeldUntilExit) {
    reasons.push("outFd must stay open until child exit");
  }
  if (input.detached && input.unref) {
    reasons.push("refuse detached+unref (closes outFd; 0-byte log)");
  }
  if (input.stdin !== "ignore" && input.stdin !== "fd") {
    reasons.push("stdin must close via Node ignore or integer fd");
  }
  if (!input.parentWaitsOnChild) {
    reasons.push("parent must wait on child exit");
  }
  if (input.outFdKind !== "integer") {
    reasons.push("outFd must be an integer fd (not WriteStream with null fd)");
  }
  if (reasons.length > 0) {
    return { ok: false, code: "hygiene-violation", reasons };
  }
  return { ok: true };
}

export type CriticProgressSample = {
  readonly atMs: number;
  /** stdout / tee log byte length at atMs. */
  readonly logByteLength: number;
  readonly stderrText?: string;
  /**
   * Tool-progress / disposable diagnostic envelope signal for text print mode.
   * Zero stdout alone is not the sole inactivity oracle (#5478 / Codex F1).
   */
  readonly toolProgressObserved?: boolean;
};

export type CriticProgressGateInput = {
  readonly samples: readonly CriticProgressSample[];
  /** Fail closed when no first byte / growth within this window from start. */
  readonly tProgressMs: number;
  /** Absolute wall-clock backstop from start; not renewed by log chatter. */
  readonly tTimeoutMs: number;
  readonly startedAtMs: number;
  readonly nowMs: number;
};

export type CriticProgressFailureCode = "no-first-byte" | "no-log-growth" | "hard-timeout";

export type CriticProgressVerdict =
  | { ok: true; phase: "running" | "complete-signal" }
  | {
      ok: false;
      code: CriticProgressFailureCode;
      stderr: string;
      haltToken: typeof CRITIC_SPAWN_PROGRESS_HALT;
    };

function latestStderr(samples: readonly CriticProgressSample[]): string {
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    const text = samples[i]?.stderrText;
    if (typeof text === "string" && text.length > 0) return text;
  }
  return "";
}

function hasProgressSignal(sample: CriticProgressSample | undefined): boolean {
  if (sample === undefined) return false;
  if (sample.logByteLength > 0) return true;
  return sample.toolProgressObserved === true;
}

/**
 * Progress gate on Critic spawn (#5478 Prefer-A bind map item 3).
 * T_timeout is an absolute backstop and cannot be renewed by log growth alone.
 */
export function evaluateCriticSpawnProgress(
  input: CriticProgressGateInput,
): CriticProgressVerdict {
  if (!(input.tProgressMs > 0) || !(input.tTimeoutMs > 0) || input.tTimeoutMs < input.tProgressMs) {
    return {
      ok: false,
      code: "hard-timeout",
      stderr: latestStderr(input.samples),
      haltToken: CRITIC_SPAWN_PROGRESS_HALT,
    };
  }

  const elapsed = input.nowMs - input.startedAtMs;
  const stderr = latestStderr(input.samples);
  const ordered = [...input.samples].sort((a, b) => a.atMs - b.atMs);
  const latest = ordered[ordered.length - 1];
  const firstProgress = ordered.find((s) => hasProgressSignal(s));

  if (elapsed >= input.tTimeoutMs) {
    return {
      ok: false,
      code: "hard-timeout",
      stderr,
      haltToken: CRITIC_SPAWN_PROGRESS_HALT,
    };
  }

  if (elapsed >= input.tProgressMs) {
    if (firstProgress === undefined) {
      const sawZeroOnly =
        ordered.length > 0 && ordered.every((s) => s.logByteLength === 0);
      const code: CriticProgressFailureCode =
        sawZeroOnly && !ordered.some((s) => s.toolProgressObserved === true)
          ? "no-first-byte"
          : "no-log-growth";
      return {
        ok: false,
        code,
        stderr,
        haltToken: CRITIC_SPAWN_PROGRESS_HALT,
      };
    }
    if (latest !== undefined && hasProgressSignal(latest)) {
      return { ok: true, phase: "running" };
    }
    return {
      ok: false,
      code: "no-log-growth",
      stderr,
      haltToken: CRITIC_SPAWN_PROGRESS_HALT,
    };
  }

  return { ok: true, phase: "running" };
}

export type CriticTerminationInput = {
  /** Named supervisor that owns the timer / kill. */
  readonly supervisorName: string;
  readonly childPid: number | null;
  /** True after killCriticProcessTree (or proven exit) for this attempt. */
  readonly terminated: boolean;
  /** Replacement/reseat requested. */
  readonly reseatRequested: boolean;
  /** Whether a critic comment already landed for this seat attempt. */
  readonly commentAlreadyPosted: boolean;
  /** Progress/timeout path failed closed. */
  readonly progressFailed: boolean;
};

export type CriticTerminationDisposition =
  | "running"
  | "complete"
  | "dispatch-fail-no-comment"
  | "late-post-reconciled";

export type CriticTerminationVerdict =
  | { ok: true; disposition: CriticTerminationDisposition }
  | {
      ok: false;
      code: "missing-supervisor" | "reseat-before-terminate";
      remediation: string;
      haltToken: typeof CRITIC_SPAWN_PROGRESS_HALT | null;
    };

/**
 * Executable termination/completion boundary (#5478 Prefer-A bind map item 4).
 * Establish termination before reseat; reconcile late post vs no-comment fail.
 */
export function evaluateCriticTerminationBoundary(
  input: CriticTerminationInput,
): CriticTerminationVerdict {
  if (input.supervisorName.trim().length === 0) {
    return {
      ok: false,
      code: "missing-supervisor",
      remediation: "name the supervisor that owns the progress/timeout timer",
      haltToken: CRITIC_SPAWN_PROGRESS_HALT,
    };
  }
  if (input.reseatRequested && !input.terminated) {
    return {
      ok: false,
      code: "reseat-before-terminate",
      remediation: "terminate the owned process tree before replacement/reseat",
      haltToken: CRITIC_SPAWN_PROGRESS_HALT,
    };
  }
  if (!input.progressFailed && !input.terminated) {
    return { ok: true, disposition: "running" };
  }
  if (input.commentAlreadyPosted) {
    return { ok: true, disposition: "late-post-reconciled" };
  }
  if (input.progressFailed) {
    return { ok: true, disposition: "dispatch-fail-no-comment" };
  }
  return { ok: true, disposition: "complete" };
}

export type CriticKillTreeSeams = {
  readonly platform?: NodeJS.Platform;
  readonly killTree?: (pid: number) => void;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly listDescendants?: (pid: number) => number[];
};

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultKillTree(pid: number, platform: NodeJS.Platform): void {
  if (platform === "win32") {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already dead
    }
  }
}

/**
 * Kill the owned critic process tree. Seams make process-tree kill fixtureable.
 */
export function killCriticProcessTree(
  pid: number,
  seams: CriticKillTreeSeams = {},
): { remaining: number[] } {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { remaining: [] };
  }
  const platform = seams.platform ?? process.platform;
  const kill = seams.killTree ?? ((target: number) => defaultKillTree(target, platform));
  const alive = seams.isPidAlive ?? defaultIsPidAlive;
  const list = seams.listDescendants ?? (() => [] as number[]);
  const snapshot = [pid, ...list(pid)];
  kill(pid);
  let remaining = snapshot.filter(alive);
  if (remaining.length > 0) {
    for (const leftover of remaining) {
      kill(leftover);
    }
    remaining = snapshot.filter(alive);
  }
  return { remaining };
}

/**
 * Probe≠progress keep: evaluateN3LaunchProbe stays launchability-only (#4432).
 * This marker documents the separation for fixtures; it does not call the probe.
 */
export function criticProgressIsSeparateFromLaunchProbe(): true {
  return true;
}
