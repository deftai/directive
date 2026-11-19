import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readOccupancy } from "./occupancy.js";
import { readRitualState } from "./ritual-sentinel.js";
import { runSessionStartOccupancyBarrier } from "./session-start-occupancy-barrier-worker.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  temps.length = 0;
});

function spawnBarrierWorker(
  root: string,
  sessionId: string,
  wait?: { readonly dir: string; readonly id: string; readonly count?: number },
): Promise<{
  code: number;
  sessionId: string;
}> {
  const workerFile = fileURLToPath(
    import.meta.resolve("./session-start-occupancy-barrier-worker.js"),
  );
  const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, workerFile], {
      env: {
        ...process.env,
        SESSION_START_BARRIER_ROOT: root,
        SESSION_START_BARRIER_SESSION: sessionId,
        ...(wait === undefined
          ? {}
          : {
              SESSION_START_BARRIER_WAIT_DIR: wait.dir,
              SESSION_START_BARRIER_WAIT_ID: wait.id,
              SESSION_START_BARRIER_WAIT_COUNT: String(wait.count ?? 2),
            }),
      },
      cwd: dirname(workerFile),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (exitCode) => {
      if (exitCode !== 0) {
        reject(new Error(`barrier worker ${sessionId} exited ${exitCode}: ${stderr}`));
        return;
      }
      const line = stdout.trim().split(/\r?\n/).at(-1) ?? "{}";
      resolve(JSON.parse(line) as { code: number; sessionId: string });
    });
  });
}

describe("session:start occupancy dest barrier (#3906)", () => {
  it("exports the barrier runner", () => {
    expect(typeof runSessionStartOccupancyBarrier).toBe("function");
  });

  it("winner/loser uses distinct owners and only the winner binds the ritual", {
    timeout: process.platform === "win32" ? 240_000 : 30_000,
  }, async () => {
    const root = mkdtempSync(join(tmpdir(), "session-start-barrier-"));
    temps.push(root);
    const waitDir = join(root, "compete");
    mkdirSync(waitDir, { recursive: true });
    const ownerA = "host:test:v1:barrier-a";
    const ownerB = "host:test:v1:barrier-b";
    const results = await Promise.all([
      spawnBarrierWorker(root, ownerA, { dir: waitDir, id: "a" }),
      spawnBarrierWorker(root, ownerB, { dir: waitDir, id: "b" }),
    ]);
    const winners = results.filter((row) => row.code === 0);
    expect(winners).toHaveLength(1);
    const winner = winners[0];
    const loser = results.find((row) => row.sessionId !== winner?.sessionId);
    expect(loser?.code).not.toBe(0);
    expect(readOccupancy(root)?.sessionId).toBe(winner?.sessionId);
    expect(readRitualState(root)[0]?.sessionId).toBe(winner?.sessionId);
  });

  it("same-id heartbeat is not exclusive dest (characterization)", {
    timeout: process.platform === "win32" ? 240_000 : 30_000,
  }, async () => {
    const root = mkdtempSync(join(tmpdir(), "session-start-barrier-same-"));
    temps.push(root);
    const waitDir = join(root, "compete");
    mkdirSync(waitDir, { recursive: true });
    const sessionId = "host:test:v1:barrier-same";
    const results = await Promise.all([
      spawnBarrierWorker(root, sessionId, { dir: waitDir, id: "a" }),
      spawnBarrierWorker(root, sessionId, { dir: waitDir, id: "b" }),
    ]);
    expect(results.every((row) => row.code === 0)).toBe(true);
    expect(readOccupancy(root)?.sessionId).toBe(sessionId);
  });
});
