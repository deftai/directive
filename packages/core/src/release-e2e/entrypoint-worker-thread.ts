/* v8 ignore start -- worker-thread bootstrap; exercised via runEntrypointWorker integration. */
import { parentPort, workerData } from "node:worker_threads";
import { runWorkerEntrypoint, type WorkerEntrypointData } from "./entrypoint-worker.js";

const result = runWorkerEntrypoint(workerData as WorkerEntrypointData);
parentPort?.postMessage(result);
/* v8 ignore stop */
