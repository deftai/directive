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

/**
 * Last sample time at which log bytes grew or tool progress was observed.
 * A flat nonempty log is not ongoing progress (#5478 Greptile P1).
 */
function lastProgressActivityAtMs(ordered: readonly CriticProgressSample[]): number | undefined {
  let last: number | undefined;
  let prevBytes = 0;
  for (const sample of ordered) {
    let progressed = false;
    if (sample.logByteLength > prevBytes) progressed = true;
    if (sample.toolProgressObserved === true) progressed = true;
    if (progressed) last = sample.atMs;
    prevBytes = Math.max(prevBytes, sample.logByteLength);
  }
  return last;
}

/**
 * Progress gate on Critic spawn (#5478 Prefer-A bind map item 3).
 * T_timeout is an absolute backstop and cannot be renewed by log growth alone.
 */
export function evaluateCriticSpawnProgress(input: CriticProgressGateInput): CriticProgressVerdict {
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
  const lastProgressAt = lastProgressActivityAtMs(ordered);

  if (elapsed >= input.tTimeoutMs) {
    return {
      ok: false,
      code: "hard-timeout",
      stderr,
      haltToken: CRITIC_SPAWN_PROGRESS_HALT,
    };
  }

  if (lastProgressAt === undefined) {
    if (elapsed < input.tProgressMs) {
      return { ok: true, phase: "running" };
    }
    const sawZeroOnly = ordered.length > 0 && ordered.every((s) => s.logByteLength === 0);
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

  // Stall clock: no byte growth / tool progress within T_progress of last activity.
  if (input.nowMs - lastProgressAt >= input.tProgressMs) {
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

export type CriticDescendantDiscovery = {
  readonly pids: readonly number[];
  /** False when discovery could not be trusted (e.g. pgrep missing/error). */
  readonly ok: boolean;
};

export type CriticKillTreeSeams = {
  readonly platform?: NodeJS.Platform;
  readonly killTree?: (pid: number) => void;
  readonly isPidAlive?: (pid: number) => boolean;
  /** Plain arrays are treated as successful discovery for fixture seams. */
  readonly listDescendants?: (pid: number) => number[] | CriticDescendantDiscovery;
};

export type CriticKillTreeResult = {
  readonly remaining: number[];
  /**
   * False when Unix descendant discovery failed. remaining is fail-closed
   * nonempty so callers must not treat the tree as safely stopped.
   */
  readonly discoveryOk: boolean;
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

function normalizeDescendantDiscovery(
  value: number[] | CriticDescendantDiscovery,
): CriticDescendantDiscovery {
  if (Array.isArray(value)) {
    return { pids: value, ok: true };
  }
  return value;
}

/**
 * Discover descendant PIDs when the critic is not a process-group leader
 * (hygiene allows detached:false). win32 relies on taskkill /T instead.
 * Fail closed (ok:false) when pgrep cannot be trusted.
 */
function defaultListDescendants(pid: number, platform: NodeJS.Platform): CriticDescendantDiscovery {
  if (platform === "win32") return { pids: [], ok: true };
  if (!Number.isInteger(pid) || pid <= 0) return { pids: [], ok: true };
  const found: number[] = [];
  const queue = [pid];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const parent = queue.pop();
    if (parent === undefined || seen.has(parent)) continue;
    seen.add(parent);
    const result = spawnSync("pgrep", ["-P", String(parent)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    // pgrep exits 1 when there are no children.
    if (result.error || (result.status !== 0 && result.status !== 1)) {
      return { pids: found, ok: false };
    }
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    for (const line of stdout.split(/\r?\n/)) {
      const child = Number(line.trim());
      if (!Number.isInteger(child) || child <= 0 || seen.has(child)) continue;
      found.push(child);
      queue.push(child);
    }
  }
  return { pids: found, ok: true };
}

/**
 * Kill the owned critic process tree. Seams make process-tree kill fixtureable.
 * Default Unix path discovers descendants so detached:false critics without a
 * process group still get children killed. Discovery failure fail-closes with
 * nonempty remaining so reseat cannot treat the tree as stopped.
 */
export function killCriticProcessTree(
  pid: number,
  seams: CriticKillTreeSeams = {},
): CriticKillTreeResult {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { remaining: [], discoveryOk: true };
  }
  const platform = seams.platform ?? process.platform;
  const kill = seams.killTree ?? ((target: number) => defaultKillTree(target, platform));
  const alive = seams.isPidAlive ?? defaultIsPidAlive;
  const list =
    seams.listDescendants ?? ((target: number) => defaultListDescendants(target, platform));
  const discovery = normalizeDescendantDiscovery(list(pid));
  const snapshot = [pid, ...discovery.pids];
  kill(pid);
  let remaining = snapshot.filter(alive);
  if (remaining.length > 0) {
    for (const leftover of remaining) {
      kill(leftover);
    }
    remaining = snapshot.filter(alive);
  }
  if (!discovery.ok) {
    // Fail closed: never report an empty remaining after untrusted discovery.
    if (remaining.length === 0) remaining = [pid];
    return { remaining, discoveryOk: false };
  }
  return { remaining, discoveryOk: true };
}

/**
 * Probe≠progress keep: evaluateN3LaunchProbe stays launchability-only (#4432).
 * This marker documents the separation for fixtures; it does not call the probe.
 */
export function criticProgressIsSeparateFromLaunchProbe(): true {
  return true;
}
