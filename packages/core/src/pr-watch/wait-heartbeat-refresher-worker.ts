/**
 * Wait-heartbeat refresher worker (#5020).
 * Parent blocks in spawnSync; this thread keeps the polling heartbeat fresh
 * via {@link containedWrite} (leaf/parent symlink refuse + replace).
 * Stop/join uses SharedArrayBuffer Atomics so the parent need not pump the
 * event loop.
 */
import { isMainThread, workerData } from "node:worker_threads";
import { containedWrite } from "../fs/contained-write.js";

/** SharedArrayBuffer slots: [0]=stop request, [1]=worker done (#5020). */
export const REFRESHER_STOP_INDEX = 0;
export const REFRESHER_DONE_INDEX = 1;

export interface WaitHeartbeatRefresherWorkerData {
  readonly rootAbs: string;
  readonly relTarget: string;
  readonly payloadBase: Readonly<Record<string, unknown>>;
  readonly intervalMs: number;
  readonly control: SharedArrayBuffer;
}

function beat(data: WaitHeartbeatRefresherWorkerData): void {
  try {
    const payload = {
      ...data.payloadBase,
      last_heartbeat_at: new Date().toISOString(),
    };
    containedWrite({
      root: data.rootAbs,
      target: data.relTarget,
      data: `${JSON.stringify(payload)}\n`,
      mode: "replace",
      mkdir: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`pr_watch: wait heartbeat refresh failed: ${msg}`);
  }
}

function runRefresher(data: WaitHeartbeatRefresherWorkerData): void {
  const view = new Int32Array(data.control);
  try {
    beat(data);
    while (Atomics.load(view, REFRESHER_STOP_INDEX) === 0) {
      Atomics.wait(view, REFRESHER_STOP_INDEX, 0, data.intervalMs);
      if (Atomics.load(view, REFRESHER_STOP_INDEX) !== 0) {
        break;
      }
      beat(data);
    }
  } finally {
    Atomics.store(view, REFRESHER_DONE_INDEX, 1);
    Atomics.notify(view, REFRESHER_DONE_INDEX);
  }
}

if (!isMainThread) {
  runRefresher(workerData as WaitHeartbeatRefresherWorkerData);
}
