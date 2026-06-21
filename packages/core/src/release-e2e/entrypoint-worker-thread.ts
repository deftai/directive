/* v8 ignore start -- worker-thread bootstrap; exercised via runEntrypointWorker integration. */
import { type MessagePort, parentPort, workerData } from "node:worker_threads";
import { runWorkerEntrypoint, type WorkerEntrypointData } from "./entrypoint-worker.js";

interface WorkerBootstrapData extends WorkerEntrypointData {
  // Sync handoff (runEntrypointWorkerSync): the parent blocks on Atomics.wait
  // over this shared signal, so the worker MUST post its result to `port`
  // first, then notify -- the cross-thread Atomics.notify is what wakes a
  // main thread whose event loop is blocked (the #1864 deadlock fix).
  signal?: Int32Array;
  port?: MessagePort;
}

const data = workerData as WorkerBootstrapData;
const result = runWorkerEntrypoint(data);
const target = data.port ?? parentPort;
try {
  target?.postMessage(result);
} catch {
  // The parent may have closed the MessageChannel after a timeout +
  // worker.terminate() (e.g. the slow "hang" path). Posting to a closed port
  // throws here, outside runWorkerEntrypoint's catch -- which would surface as
  // a worker 'error' event. The parent already returned its timeout result, so
  // swallow it (#1864 / #1865 review).
}
if (data.signal !== undefined) {
  Atomics.store(data.signal, 0, 1);
  Atomics.notify(data.signal, 0);
}
/* v8 ignore stop */
