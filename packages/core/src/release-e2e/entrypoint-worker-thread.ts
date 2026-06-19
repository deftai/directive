import { parentPort, workerData } from "node:worker_threads";
import { runWorkerEntrypoint, type WorkerEntrypointData } from "./entrypoint-worker.js";

const result = runWorkerEntrypoint(workerData as WorkerEntrypointData);
parentPort?.postMessage(result);
