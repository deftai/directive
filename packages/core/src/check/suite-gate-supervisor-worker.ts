/**
 * Worker thread for the suite-gate supervisor (#4230).
 * Notifies the blocked parent via Atomics so the main event loop can stay
 * parked in `Atomics.wait` (same pattern as release-e2e entrypoint).
 */
import { isMainThread, type MessagePort, parentPort, workerData } from "node:worker_threads";
import { type SupervisedGatePlan, superviseChild } from "./suite-gate-supervisor-lib.js";

interface WorkerPayload {
  readonly plan: SupervisedGatePlan;
  readonly signal: Int32Array;
  readonly port: MessagePort;
}

/** True when this module is executing as the supervisor worker thread. */
export function isSuiteGateSupervisorWorker(): boolean {
  return !isMainThread;
}

if (!isMainThread) {
  const payload = workerData as WorkerPayload;

  void superviseChild(payload.plan)
    .then((result) => {
      payload.port.postMessage(result);
      Atomics.store(payload.signal, 0, 1);
      Atomics.notify(payload.signal, 0);
    })
    .catch((err: unknown) => {
      payload.port.postMessage({
        exitCode: 1,
        timedOut: false,
        signal: null,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        teePath: "",
        teeRel: "",
        spawnError: err instanceof Error ? err.message : String(err),
      });
      Atomics.store(payload.signal, 0, 1);
      Atomics.notify(payload.signal, 0);
    })
    .finally(() => {
      parentPort?.close();
    });
}
