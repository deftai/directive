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
  isPidAlive,
  killDescendantTree,
  type SupervisedGatePlan,
  type SupervisedGateResult,
  superviseChild,
} from "./suite-gate-supervisor-lib.js";

export interface TimedChildHandle {
  readonly exitCode: number | null;
  readonly pid?: number;
}

export interface TimedChildPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly platform?: NodeJS.Platform;
  readonly killTree?: (pid: number, handle: TimedChildHandle) => void;
  readonly listDescendants?: (pid: number) => number[];
  readonly isPidAlive?: (pid: number) => boolean;
}

/** Null when the child already exited (avoid taskkill on a recycled PID). */
export function confirmChildHandleForKill(child: TimedChildHandle): number | null {
  if (child.exitCode !== null) return null;
  if (child.pid === undefined) return null;
  return child.pid;
}

function listDirectChildPids(pid: number, platform: NodeJS.Platform): number[] {
  if (platform === "win32") {
    const result = spawnSync(
      "wmic",
      ["process", "where", `ParentProcessId=${pid}`, "get", "ProcessId", "/VALUE"],
      { encoding: "utf8", windowsHide: true, timeout: 5_000 },
    );
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
    timeout: 5_000,
  });
  const ids: number[] = [];
  for (const line of (result.stdout ?? "").split(/\r?\n/)) {
    const n = Number(line.trim());
    if (Number.isInteger(n) && n > 0 && n !== pid) ids.push(n);
  }
  return ids;
}

export function listDescendantPids(
  rootPid: number,
  platform: NodeJS.Platform,
  listDirect: (pid: number) => number[] = (pid) => listDirectChildPids(pid, platform),
): number[] {
  const visited = new Set<number>([rootPid]);
  const found: number[] = [];
  const stack = [rootPid];
  while (stack.length > 0) {
    const current = stack.pop() as number;
    for (const child of listDirect(current)) {
      if (visited.has(child)) continue;
      visited.add(child);
      found.push(child);
      stack.push(child);
    }
  }
  return found;
}

export function killTreeAndProveEmpty(
  pid: number,
  seams: {
    readonly platform?: NodeJS.Platform;
    readonly killTree?: (target: number) => void;
    readonly listDescendants?: (target: number) => number[];
    readonly isPidAlive?: (target: number) => boolean;
  } = {},
): { remaining: number[] } {
  const platform = seams.platform ?? process.platform;
  const kill = seams.killTree ?? ((target: number) => killDescendantTree(target, { platform }));
  const list = seams.listDescendants ?? ((target: number) => listDescendantPids(target, platform));
  const alive = seams.isPidAlive ?? isPidAlive;
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

/** Tee-optional hang kill: spawn + timeout + tree-kill, no suite tee files. */
export async function superviseTimedChild(plan: TimedChildPlan): Promise<SupervisedGateResult> {
  const platform = plan.platform ?? process.platform;
  const stdoutCap = createBoundedCapture();
  const stderrCap = createBoundedCapture();
  const child = spawn(plan.command, [...plan.args], {
    cwd: plan.cwd,
    env: plan.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: platform !== "win32" && plan.timeoutMs !== undefined,
    windowsHide: true,
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    appendBoundedCapture(stdoutCap, chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    appendBoundedCapture(stderrCap, chunk);
  });

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (plan.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      const pid = confirmChildHandleForKill(child);
      if (pid === null) return;
      const handle = { exitCode: child.exitCode, pid: child.pid };
      if (plan.killTree !== undefined) {
        plan.killTree(pid, handle);
        return;
      }
      killTreeAndProveEmpty(pid, {
        platform,
        listDescendants: plan.listDescendants,
        isPidAlive: plan.isPidAlive,
      });
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
    return {
      exitCode: 124,
      timedOut: true,
      signal: exit.signal,
      stdout,
      stderr,
      ...emptyTee,
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
  payload.port.postMessage(result);
  Atomics.store(payload.signal, 0, 1);
  Atomics.notify(payload.signal, 0);
}

if (!isMainThread) {
  const payload = workerData as WorkerPayload;
  const work =
    payload.mode === "timed"
      ? superviseTimedChild(payload.plan as TimedChildPlan)
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
