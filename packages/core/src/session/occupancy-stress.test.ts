import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readOccupancy } from "./occupancy.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  temps.length = 0;
});

function parseMarkers(log: string): string[] {
  return log
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("ENTER ") || line.startsWith("LEAVE "));
}

function markersNeverInterleave(markers: string[]): boolean {
  let depth = 0;
  let owner: string | null = null;
  for (const line of markers) {
    const [kind, id] = line.split(" ");
    if (kind === "ENTER") {
      if (depth !== 0) return false;
      depth = 1;
      owner = id;
    } else if (kind === "LEAVE") {
      if (depth !== 1 || owner !== id) return false;
      depth = 0;
      owner = null;
    }
  }
  return depth === 0;
}

describe("occupancy concurrency stress (#3433)", () => {
  it("child workers never interleave live leases", { timeout: 30_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "occupancy-stress-"));
    temps.push(root);
    const logPath = join(root, "markers.log");
    writeFileSync(logPath, "", "utf8");
    const workerFile = fileURLToPath(new URL("./occupancy-stress-worker.ts", import.meta.url));
    const workers = 4;
    const rounds = 6;
    const jobs = Array.from({ length: workers }, (_, i) => {
      return new Promise<void>((resolve, reject) => {
        // vitest 4 dropped vite-node (#3480); tsx is the spawn runner for this
        // TypeScript child worker.
        const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));
        const child = spawn(process.execPath, [tsxCli, workerFile], {
          env: {
            ...process.env,
            OCCUPANCY_STRESS_ROOT: root,
            OCCUPANCY_STRESS_LOG: logPath,
            OCCUPANCY_STRESS_SESSION: `stress-${i}`,
            OCCUPANCY_STRESS_ROUNDS: String(rounds),
          },
          cwd: dirname(workerFile),
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`stress worker ${i} exited ${code}: ${stderr}`));
        });
      });
    });
    await Promise.all(jobs);
    const markers = parseMarkers(existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
    expect(markers.length).toBeGreaterThan(0);
    expect(markersNeverInterleave(markers)).toBe(true);
    expect(readOccupancy(root)).toBeNull();
  });
});
