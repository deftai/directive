import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { containedWrite } from "../fs/contained-write.js";
import {
  REFRESHER_DONE_INDEX,
  REFRESHER_STOP_INDEX,
  type WaitHeartbeatRefresherWorkerData,
} from "./wait-heartbeat-refresher-worker.js";

function resolveWorkerPath(): string | null {
  const local = fileURLToPath(new URL("./wait-heartbeat-refresher-worker.js", import.meta.url));
  const srcSegment = `${sep}src${sep}`;
  const srcIdx = local.indexOf(srcSegment);
  const distPath =
    srcIdx === -1
      ? local
      : `${local.slice(0, srcIdx)}${sep}dist${sep}${local.slice(srcIdx + srcSegment.length)}`;
  const chosen = existsSync(local) ? local : distPath;
  if (!existsSync(chosen)) {
    return null;
  }
  return chosen;
}

describe("wait-heartbeat-refresher-worker (#5020)", () => {
  it("exports SharedArrayBuffer slot indices used by the parent join", () => {
    expect(REFRESHER_STOP_INDEX).toBe(0);
    expect(REFRESHER_DONE_INDEX).toBe(1);
    expect(REFRESHER_DONE_INDEX).not.toBe(REFRESHER_STOP_INDEX);
  });

  it("worker entry writes through containedWrite then signals done on stop", async () => {
    const root = mkdtempSync(pathJoin(tmpdir(), "pr-watch-hb-worker-"));
    const relTarget = [".deft-scratch", "subagent-status", "worker-probe.json"].join("/");
    containedWrite({
      root,
      target: relTarget,
      data: `${JSON.stringify({ phase: "seed", last_heartbeat_at: "1970-01-01T00:00:00.000Z" })}\n`,
      mode: "create",
      mkdir: true,
    });
    const absTarget = pathJoin(root, ".deft-scratch", "subagent-status", "worker-probe.json");
    const firstAt = (JSON.parse(readFileSync(absTarget, "utf8")) as { last_heartbeat_at: string })
      .last_heartbeat_at;

    const control = new SharedArrayBuffer(8);
    const view = new Int32Array(control);
    const workerData: WaitHeartbeatRefresherWorkerData = {
      rootAbs: root,
      relTarget,
      payloadBase: {
        agent_id: "worker-probe",
        parent_id: "pr-watch",
        last_message: "probe",
        phase: "polling",
        terminal_state: null,
        pr_number: 1,
        pid: 1,
      },
      intervalMs: 50,
      control,
    };

    const workerPath = resolveWorkerPath();
    expect(workerPath).not.toBeNull();
    if (workerPath === null) {
      return;
    }
    const worker = new Worker(workerPath, { workerData });
    try {
      Atomics.wait(view, REFRESHER_STOP_INDEX, 0, 120);
      const secondAt = (
        JSON.parse(readFileSync(absTarget, "utf8")) as { last_heartbeat_at: string }
      ).last_heartbeat_at;
      expect(Date.parse(secondAt)).toBeGreaterThan(Date.parse(firstAt));

      Atomics.store(view, REFRESHER_STOP_INDEX, 1);
      Atomics.notify(view, REFRESHER_STOP_INDEX);
      const joinResult = Atomics.wait(view, REFRESHER_DONE_INDEX, 0, 1_500);
      expect(joinResult === "ok" || joinResult === "not-equal").toBe(true);
      expect(Atomics.load(view, REFRESHER_DONE_INDEX)).toBe(1);
    } finally {
      await worker.terminate();
    }
  });
});
