/**
 * Synchronous suite-gate supervisor (#4230).
 *
 * Hygiene gates keep `captureSpawn`. The suite gate tees through a worker so
 * the orchestrator function stays sync. Timeout is armed only when `timeoutMs`
 * is set (release Step 5). Ambient `task check` tees without a 20-minute kill.
 */
import { existsSync } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import {
  mintSuiteRunId,
  pruneSuiteTees,
  type SupervisedGatePlan,
  type SupervisedGateResult,
} from "./suite-gate-supervisor-lib.js";

export {
  assertTeePathContained,
  FAILURE_SIGNAL_TAIL_LINES,
  type KillTreeSeams,
  killDescendantTree,
  mintSuiteRunId,
  ownerPidFromTeeName,
  pruneSuiteTees,
  readTeeText,
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
  touchTeeMtime,
} from "./suite-gate-supervisor-lib.js";

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
    // Vitest/src path without a compiled worker — run in-process (tests).
    throw new Error(
      `suite-gate supervisor worker missing at ${workerPath}; use superviseChild in tests`,
    );
  }
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const channel = new MessageChannel();
  let worker: Worker;
  try {
    worker = new Worker(workerPath, {
      workerData: { plan: fullPlan, signal, port: channel.port2 },
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
  worker.on("error", () => {});
  const waitMs = fullPlan.timeoutMs !== undefined ? fullPlan.timeoutMs + 15_000 : 60 * 60 * 1000;
  try {
    const waitResult = Atomics.wait(signal, 0, 0, waitMs);
    if (waitResult === "timed-out") {
      return {
        exitCode: 124,
        timedOut: true,
        signal: null,
        stdout: "",
        stderr: "suite-gate supervisor worker did not notify before backstop",
        teePath: "",
        teeRel: "",
      };
    }
    const received = receiveMessageOnPort(channel.port1);
    if (received === undefined) {
      return {
        exitCode: 1,
        timedOut: false,
        signal: null,
        stdout: "",
        stderr: "suite-gate supervisor worker produced no result",
        teePath: "",
        teeRel: "",
      };
    }
    return received.message as SupervisedGateResult;
  } finally {
    channel.port1.close();
    void worker.terminate();
  }
}
