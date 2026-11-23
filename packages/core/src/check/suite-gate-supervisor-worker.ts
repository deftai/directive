/**
 * Worker thread for the suite-gate supervisor (#4230) and the tee-optional
 * timed-child hang kill (#4801). Notifies the blocked parent via Atomics so
 * the cached runner stays sync.
 */
import { spawn, spawnSync } from "node:child_process";
import { isMainThread, type MessagePort, parentPort, workerData } from "node:worker_threads";
import {
  appendBoundedCapture,
  boundedCaptureText,
  createBoundedCapture,
  isPidRunning,
  killDescendantTree,
  type SupervisedGatePlan,
  type SupervisedGateResult,
  superviseChild,
  type TreeCleanupOutcome,
} from "./suite-gate-supervisor-lib.js";

export interface TimedChildHandle {
  readonly exitCode: number | null;
  readonly pid?: number;
}

/** Lists the direct children of `pid`; `null` means the listing failed (#6904). */
export type ListDirectChildren = (pid: number) => number[] | null;

export interface TimedChildPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly platform?: NodeJS.Platform;
  readonly windowsVerbatimArguments?: boolean;
  readonly killTree?: (pid: number, handle: TimedChildHandle) => void;
  readonly listDescendants?: (pid: number) => number[];
  /** Test seam for the descendant scan (#6904); `null` is a failed listing. */
  readonly listDirect?: ListDirectChildren;
  /** Test seam for the descendant scan budget (#6904). */
  readonly scanBudgetMs?: number;
  readonly isPidAlive?: (pid: number) => boolean;
}

/** Tagged timed-mode port messages (#6904). Suite mode posts the bare result. */
export type TimedChildMessage =
  | { readonly kind: "spawned"; readonly pid: number }
  | { readonly kind: "result"; readonly result: SupervisedGateResult };

/** Null when the child already exited (avoid taskkill on a recycled PID). */
export function confirmChildHandleForKill(child: TimedChildHandle): number | null {
  if (child.exitCode !== null) return null;
  if (child.pid === undefined) return null;
  return child.pid;
}

/**
 * Direct children of `pid`, or `null` when the listing failed (#6904): a spawn
 * error (missing `wmic` or `pgrep`), a timeout, or an exit status other than
 * success or `pgrep`'s no-match status 1.
 */
function listDirectChildPids(
  pid: number,
  platform: NodeJS.Platform,
  timeoutMs = 5_000,
): number[] | null {
  if (platform === "win32") {
    const result = spawnSync(
      "wmic",
      ["process", "where", `ParentProcessId=${pid}`, "get", "ProcessId", "/VALUE"],
      { encoding: "utf8", windowsHide: true, timeout: timeoutMs },
    );
    if (result.error !== undefined || result.status !== 0) return null;
    const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const ids: number[] = [];
    for (const match of text.matchAll(/ProcessId=(\d+)/g)) {
      const n = Number(match[1]);
      if (Number.isInteger(n) && n > 0 && n !== pid) ids.push(n);
    }
    return ids;
  }
  const result = spawnSync("pgrep", ["-P", String(pid)], {
    encoding: "utf8",
    timeout: timeoutMs,
  });
  if (result.error !== undefined || (result.status !== 0 && result.status !== 1)) return null;
  const ids: number[] = [];
  for (const line of (result.stdout ?? "").split(/\r?\n/)) {
    const n = Number(line.trim());
    if (Number.isInteger(n) && n > 0 && n !== pid) ids.push(n);
  }
  return ids;
}

/**
 * Walk the descendants of `rootPid` and say whether the walk completed
 * (#6904). `complete` is false when the budget runs out before the walk ends
 * or when any listing fails.
 */
export function scanDescendantPids(
  rootPid: number,
  platform: NodeJS.Platform,
  listDirect: ListDirectChildren = (pid) => listDirectChildPids(pid, platform),
  budgetMs?: number,
): { pids: number[]; complete: boolean } {
  const visited = new Set<number>([rootPid]);
  const found: number[] = [];
  const stack = [rootPid];
  const deadline = budgetMs !== undefined ? Date.now() + budgetMs : Number.POSITIVE_INFINITY;
  let complete = true;
  while (stack.length > 0) {
    if (Date.now() >= deadline) {
      complete = false;
      break;
    }
    const current = stack.pop() as number;
    const children = listDirect(current);
    if (children === null) {
      complete = false;
      continue;
    }
    for (const child of children) {
      if (visited.has(child)) continue;
      visited.add(child);
      found.push(child);
      stack.push(child);
    }
  }
  return { pids: found, complete };
}

export function listDescendantPids(
  rootPid: number,
  platform: NodeJS.Platform,
  listDirect: ListDirectChildren = (pid) => listDirectChildPids(pid, platform),
  budgetMs?: number,
): number[] {
  return scanDescendantPids(rootPid, platform, listDirect, budgetMs).pids;
}

export function killTreeAndProveEmpty(
  pid: number,
  seams: {
    readonly platform?: NodeJS.Platform;
    readonly killTree?: (target: number) => void;
    /** Legacy list seam; its list counts as a completed scan. */
    readonly listDescendants?: (target: number) => number[];
    readonly listDirect?: ListDirectChildren;
    readonly scanBudgetMs?: number;
    readonly isPidAlive?: (target: number) => boolean;
  } = {},
): { remaining: number[]; scanComplete: boolean } {
  const platform = seams.platform ?? process.platform;
  const kill = seams.killTree ?? ((target: number) => killDescendantTree(target, { platform }));
  const scan =
    seams.listDescendants !== undefined
      ? { pids: seams.listDescendants(pid), complete: true }
      : scanDescendantPids(
          pid,
          platform,
          seams.listDirect ?? ((childPid) => listDirectChildPids(childPid, platform)),
          seams.scanBudgetMs ?? 5_000,
        );
  const alive = seams.isPidAlive ?? ((target: number) => isPidRunning(target, platform));
  // Snapshot while the tree is intact, then kill root/group first. Post-kill
  // pgrep -P from a dead root cannot see reparented process groups (#4801 P1).
  const snapshot = [pid, ...scan.pids];
  kill(pid);
  let remaining = snapshot.filter(alive);
  if (remaining.length > 0) {
    for (const leftover of remaining) {
      kill(leftover);
    }
    remaining = snapshot.filter(alive);
  }
  return { remaining, scanComplete: scan.complete };
}

/** What the deadline kill found, before the root's exit event (#6904). */
export interface DeadlineCleanup {
  /** Set when no kill proof ran: the child had exited, or the `killTree` seam ran. */
  readonly unverified: boolean;
  readonly rootPid?: number;
  readonly remaining: readonly number[];
  readonly scanComplete: boolean;
}

/**
 * The deadline kill (#4801 / #6904). Only this worker kills, from its live
 * child handle. When the child already exited, nothing is killed.
 */
export function runDeadlineCleanup(
  handle: TimedChildHandle,
  plan: TimedChildPlan,
  platform: NodeJS.Platform,
  killProof: typeof killTreeAndProveEmpty = killTreeAndProveEmpty,
): DeadlineCleanup {
  const pid = confirmChildHandleForKill(handle);
  if (pid === null) return { unverified: true, remaining: [], scanComplete: false };
  if (plan.killTree !== undefined) {
    plan.killTree(pid, handle);
    return { unverified: true, rootPid: pid, remaining: [], scanComplete: false };
  }
  const proof = killProof(pid, {
    platform,
    listDescendants: plan.listDescendants,
    listDirect: plan.listDirect,
    scanBudgetMs: plan.scanBudgetMs,
    isPidAlive: plan.isPidAlive,
  });
  return { unverified: false, rootPid: pid, ...proof };
}

/**
 * Cleanup outcome once the root's exit event arrived (#6904). The root has
 * exited by then, so it is dropped; the other PIDs from the deadline kill are
 * checked again, since a killed process can take a moment to exit.
 */
export function settleTreeCleanup(
  cleanup: DeadlineCleanup,
  alive: (pid: number) => boolean,
): { treeCleanup: TreeCleanupOutcome; survivorPids?: readonly number[] } {
  if (cleanup.unverified) return { treeCleanup: "unverified" };
  const survivors = cleanup.remaining.filter((pid) => pid !== cleanup.rootPid && alive(pid));
  if (survivors.length > 0) return { treeCleanup: "survivors", survivorPids: survivors };
  return { treeCleanup: cleanup.scanComplete ? "stopped" : "unverified" };
}

/** Tee-optional hang kill: spawn + timeout + tree-kill, no suite tee files. */
export async function superviseTimedChild(
  plan: TimedChildPlan,
  hooks: { readonly onSpawn?: (pid: number) => void } = {},
): Promise<SupervisedGateResult> {
  const platform = plan.platform ?? process.platform;
  const stdoutCap = createBoundedCapture();
  const stderrCap = createBoundedCapture();
  const child = spawn(plan.command, [...plan.args], {
    cwd: plan.cwd,
    env: plan.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: platform !== "win32" && plan.timeoutMs !== undefined,
    windowsHide: true,
    ...(plan.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true as const } : {}),
  });
  if (child.pid !== undefined) hooks.onSpawn?.(child.pid);
  child.stdout?.on("data", (chunk: Buffer) => {
    appendBoundedCapture(stdoutCap, chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    appendBoundedCapture(stderrCap, chunk);
  });

  let timedOut = false;
  let cleanup: DeadlineCleanup | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (plan.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      cleanup = runDeadlineCleanup({ exitCode: child.exitCode, pid: child.pid }, plan, platform);
    }, plan.timeoutMs);
  }

  const exit = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    error?: Error;
  }>((resolveExit) => {
    child.on("error", (error) => resolveExit({ code: 1, signal: null, error }));
    child.on("exit", (code, signal) => resolveExit({ code, signal }));
  });
  if (timer !== undefined) clearTimeout(timer);
  const stdout = boundedCaptureText(stdoutCap);
  const stderr = boundedCaptureText(stderrCap);
  const emptyTee = { teePath: "", teeRel: "" };
  if (timedOut) {
    const alive = plan.isPidAlive ?? ((pid: number) => isPidRunning(pid, platform));
    const settled = settleTreeCleanup(
      cleanup ?? { unverified: true, remaining: [], scanComplete: false },
      alive,
    );
    return {
      exitCode: 124,
      timedOut: true,
      signal: exit.signal,
      stdout,
      stderr,
      ...emptyTee,
      ...settled,
    };
  }
  if (exit.error !== undefined) {
    return {
      exitCode: 1,
      timedOut: false,
      signal: null,
      stdout,
      stderr,
      ...emptyTee,
      spawnError: exit.error.message,
    };
  }
  if (exit.signal) {
    return {
      exitCode: 1,
      timedOut: false,
      signal: exit.signal,
      stdout,
      stderr,
      ...emptyTee,
    };
  }
  return {
    exitCode: exit.code ?? 1,
    timedOut: false,
    signal: null,
    stdout,
    stderr,
    ...emptyTee,
  };
}

interface WorkerPayload {
  readonly plan: SupervisedGatePlan | TimedChildPlan;
  readonly signal: Int32Array;
  readonly port: MessagePort;
  readonly mode?: "suite" | "timed";
}

/** True when this module is executing as the supervisor worker thread. */
export function isSuiteGateSupervisorWorker(): boolean {
  return !isMainThread;
}

function postWorkerResult(payload: WorkerPayload, result: SupervisedGateResult): void {
  if (payload.mode === "timed") {
    const message: TimedChildMessage = { kind: "result", result };
    payload.port.postMessage(message);
  } else {
    payload.port.postMessage(result);
  }
  Atomics.store(payload.signal, 0, 1);
  Atomics.notify(payload.signal, 0);
}

if (!isMainThread) {
  const payload = workerData as WorkerPayload;
  const work =
    payload.mode === "timed"
      ? superviseTimedChild(payload.plan as TimedChildPlan, {
          onSpawn: (pid) => {
            const message: TimedChildMessage = { kind: "spawned", pid };
            payload.port.postMessage(message);
          },
        })
      : superviseChild(payload.plan as SupervisedGatePlan);

  void work
    .then((result) => {
      postWorkerResult(payload, result);
    })
    .catch((err: unknown) => {
      postWorkerResult(payload, {
        exitCode: 1,
        timedOut: false,
        signal: null,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        teePath: "",
        teeRel: "",
        spawnError: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      parentPort?.close();
    });
}
