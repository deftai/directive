/**
 * Synchronous suite-gate supervisor (#4230) and tee-optional timed-child
 * hang kill (#4801).
 *
 * Hygiene gates keep `captureSpawn` unless a Step 5 deadline is armed; then
 * they use `runTimedChild` (Worker + Atomics.wait, no suite tees). The suite
 * gate still tees through `runSupervisedGate`. Timeout is armed only when
 * `timeoutMs` is set (release Step 5). Ambient `task check` tees the suite
 * without a 20-minute kill.
 */
import { existsSync } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MessageChannel,
  type MessagePort,
  receiveMessageOnPort,
  Worker,
} from "node:worker_threads";
import {
  bindWorkerFailureToWaiter,
  mintSuiteRunId,
  pruneSuiteTees,
  type SupervisedGatePlan,
  type SupervisedGateResult,
  type TreeCleanupOutcome,
} from "./suite-gate-supervisor-lib.js";
import type { TimedChildMessage, TimedChildPlan } from "./suite-gate-supervisor-worker.js";

export {
  appendBoundedCapture,
  assertTeePathContained,
  bindWorkerFailureToWaiter,
  boundedCaptureText,
  createBoundedCapture,
  isPidRunning,
  type KillTreeSeams,
  killDescendantTree,
  mintSuiteRunId,
  notifySupervisorWaiter,
  ownerPidFromTeeName,
  pruneSuiteTees,
  readTeeText,
  SUITE_CAPTURE_MAX_BYTES,
  SUITE_TEE_DIR_REL,
  SUITE_TEE_HANG_CEILING_MS,
  SUITE_TEE_PRUNE_AGE_MS,
  type SupervisedGatePlan,
  type SupervisedGateResult,
  sanitizeSessionDirName,
  selectFailureSignalLines,
  suiteActuallyRan,
  suiteTeeRelativePath,
  superviseChild,
  type TreeCleanupOutcome,
  touchTeeMtime,
} from "./suite-gate-supervisor-lib.js";

export {
  confirmChildHandleForKill,
  type DeadlineCleanup,
  killTreeAndProveEmpty,
  type ListDirectChildren,
  listDescendantPids,
  runDeadlineCleanup,
  scanDescendantPids,
  settleTreeCleanup,
  superviseTimedChild,
  type TimedChildHandle,
  type TimedChildMessage,
  type TimedChildPlan,
} from "./suite-gate-supervisor-worker.js";

function resolveWorkerPath(): string {
  const localWorker = fileURLToPath(new URL("./suite-gate-supervisor-worker.js", import.meta.url));
  const srcSegment = `${sep}src${sep}`;
  const srcIdx = localWorker.indexOf(srcSegment);
  const distWorker =
    srcIdx === -1
      ? localWorker
      : `${localWorker.slice(0, srcIdx)}${sep}dist${sep}${localWorker.slice(srcIdx + srcSegment.length)}`;
  return existsSync(localWorker) ? localWorker : distWorker;
}

/**
 * Run the suite child, tee output, and optionally kill the tree at `timeoutMs`.
 * Blocks the caller via `Atomics.wait` (worker thread owns the child).
 */
export function runSupervisedGate(plan: SupervisedGatePlan): SupervisedGateResult {
  pruneSuiteTees({ projectRoot: plan.projectRoot });
  const fullPlan: SupervisedGatePlan = {
    ...plan,
    runId: plan.runId ?? mintSuiteRunId(),
  };
  const workerPath = resolveWorkerPath();
  if (!existsSync(workerPath)) {
    throw new Error(
      `suite-gate supervisor worker missing at ${workerPath}; use superviseChild in tests`,
    );
  }
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const channel = new MessageChannel();
  let worker: Worker;
  try {
    worker = new Worker(workerPath, {
      workerData: { plan: fullPlan, signal, port: channel.port2, mode: "suite" },
      transferList: [channel.port2],
    });
  } catch (err) {
    channel.port1.close();
    return {
      exitCode: 1,
      timedOut: false,
      signal: null,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      teePath: "",
      teeRel: "",
      spawnError: err instanceof Error ? err.message : String(err),
    };
  }
  const failure: { failure?: string } = {};
  bindWorkerFailureToWaiter(worker, signal, failure);
  const waitMs = fullPlan.timeoutMs !== undefined ? fullPlan.timeoutMs + 15_000 : 60 * 60 * 1000;
  try {
    const waitResult = Atomics.wait(signal, 0, 0, waitMs);
    if (waitResult === "timed-out") {
      return {
        exitCode: 124,
        timedOut: true,
        signal: null,
        stdout: "",
        stderr: failure.failure ?? "suite-gate supervisor worker did not notify before backstop",
        teePath: "",
        teeRel: "",
        spawnError: failure.failure,
      };
    }
    const received = receiveMessageOnPort(channel.port1);
    if (received === undefined) {
      return {
        exitCode: 1,
        timedOut: false,
        signal: null,
        stdout: "",
        stderr: failure.failure ?? "suite-gate supervisor worker produced no result",
        teePath: "",
        teeRel: "",
        spawnError: failure.failure,
      };
    }
    return received.message as SupervisedGateResult;
  } finally {
    channel.port1.close();
    void worker.terminate();
  }
}

/**
 * Worker + Atomics.wait wrap of `superviseTimedChild` (no suite tees / prune).
 * Does not throw when the compiled worker is missing; tests call
 * `superviseTimedChild` in-process.
 */
export function runTimedChild(plan: TimedChildPlan): SupervisedGateResult {
  const workerPath = resolveWorkerPath();
  if (!existsSync(workerPath)) {
    return {
      exitCode: 1,
      timedOut: false,
      signal: null,
      stdout: "",
      stderr: `timed-child supervisor worker missing at ${workerPath}`,
      teePath: "",
      teeRel: "",
      spawnError: `timed-child supervisor worker missing at ${workerPath}`,
    };
  }
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const channel = new MessageChannel();
  let worker: Worker;
  try {
    worker = new Worker(workerPath, {
      workerData: { plan, signal, port: channel.port2, mode: "timed" },
      transferList: [channel.port2],
    });
  } catch (err) {
    channel.port1.close();
    return {
      exitCode: 1,
      timedOut: false,
      signal: null,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      teePath: "",
      teeRel: "",
      spawnError: err instanceof Error ? err.message : String(err),
    };
  }
  const failure: { failure?: string } = {};
  bindWorkerFailureToWaiter(worker, signal, failure);
  const waitMs = plan.timeoutMs !== undefined ? plan.timeoutMs + 15_000 : 60 * 60 * 1000;
  try {
    const waitResult = Atomics.wait(signal, 0, 0, waitMs);
    return collectTimedChildResult(channel.port1, {
      backstopExpired: waitResult === "timed-out",
      failure: failure.failure,
      timeoutArmed: plan.timeoutMs !== undefined,
    });
  } finally {
    channel.port1.close();
    void worker.terminate();
  }
}

/**
 * Read every queued timed-mode message (#6904): take the `result` message as
 * the result and remember the last `spawned` PID. With no result, return a
 * failure; when a timeout was armed it carries `treeCleanup: unverified` and
 * the last reported PID. The PID is shown to the operator only: this function
 * has no kill path, and the calling thread never kills (PID reuse, #6943).
 */
export function collectTimedChildResult(
  port: MessagePort,
  wait: {
    readonly backstopExpired: boolean;
    readonly failure?: string;
    readonly timeoutArmed: boolean;
  },
): SupervisedGateResult {
  let result: SupervisedGateResult | undefined;
  let lastReportedPid: number | undefined;
  for (;;) {
    const received = receiveMessageOnPort(port);
    if (received === undefined) break;
    const message = received.message as TimedChildMessage;
    if (message.kind === "result") result = message.result;
    else if (message.kind === "spawned") lastReportedPid = message.pid;
  }
  if (result !== undefined) return result;
  const cleanup: {
    treeCleanup?: TreeCleanupOutcome;
    lastReportedPid?: number;
  } = wait.timeoutArmed
    ? {
        treeCleanup: "unverified",
        ...(lastReportedPid !== undefined ? { lastReportedPid } : {}),
      }
    : {};
  if (wait.backstopExpired) {
    return {
      exitCode: 124,
      timedOut: true,
      signal: null,
      stdout: "",
      stderr: wait.failure ?? "timed-child supervisor worker did not notify before backstop",
      teePath: "",
      teeRel: "",
      spawnError: wait.failure,
      ...cleanup,
    };
  }
  return {
    exitCode: 1,
    timedOut: false,
    signal: null,
    stdout: "",
    stderr: wait.failure ?? "timed-child supervisor worker produced no result",
    teePath: "",
    teeRel: "",
    spawnError: wait.failure,
    ...cleanup,
  };
}
