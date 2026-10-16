import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { destContentionItTimeout } from "../vitest-runner/dest-contention-it-timeout.helper.test.js";
import { formatBriefJson } from "./vbrief-json.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

async function waitForPath(path: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for ${path}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 15));
  }
}

function spawnWorker(args: {
  readonly workerFile: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [tsxCli, args.workerFile], {
      env: { ...process.env, ...args.env },
      cwd: dirname(args.workerFile),
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
    child.once("exit", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}

describe("scope dest exclusive-create concurrency (#3908)", () => {
  it(
    "two processes cannot both exclusive-create the same dest",
    destContentionItTimeout(),
    async () => {
      const root = tempDir("scope-3908-excl-");
      mkdirSync(join(root, "xbrief", "completed"), { recursive: true });
      const destPath = join(root, "xbrief", "completed", "race.xbrief.json");
      const workerDir = tempDir("scope-3908-worker-");
      const transitionAbs = fileURLToPath(new URL("./transition.ts", import.meta.url));
      const workerFile = join(workerDir, "publish-dest-worker.ts");
      writeFileSync(
        workerFile,
        `import { publishScopeDestExclusive } from ${JSON.stringify(transitionAbs)};
const destPath = process.env.SCOPE_3908_DEST ?? "";
const projectRoot = process.env.SCOPE_3908_ROOT ?? "";
const formatted = process.env.SCOPE_3908_PAYLOAD ?? "";
const result = publishScopeDestExclusive({ destPath, formatted, projectRoot });
process.stdout.write(JSON.stringify(result) + "\\n");
`,
        "utf8",
      );
      const [a, b] = await Promise.all([
        spawnWorker({
          workerFile,
          env: {
            SCOPE_3908_DEST: destPath,
            SCOPE_3908_ROOT: root,
            SCOPE_3908_PAYLOAD: "payload-a\n",
          },
        }),
        spawnWorker({
          workerFile,
          env: {
            SCOPE_3908_DEST: destPath,
            SCOPE_3908_ROOT: root,
            SCOPE_3908_PAYLOAD: "payload-b\n",
          },
        }),
      ]);
      expect(a.code).toBe(0);
      expect(b.code).toBe(0);
      const ra = JSON.parse(a.stdout.trim()) as { ok: boolean; message: string };
      const rb = JSON.parse(b.stdout.trim()) as { ok: boolean; message: string };
      const oks = [ra, rb].filter((r) => r.ok);
      const fails = [ra, rb].filter((r) => !r.ok);
      expect(oks).toHaveLength(1);
      expect(fails).toHaveLength(1);
      expect(fails[0]?.message).toContain("Target already exists");
      const destBytes = readFileSync(destPath, "utf8");
      expect(destBytes === "payload-a\n" || destBytes === "payload-b\n").toBe(true);
    },
  );

  it(
    "two complete processes leave one dest and cannot unlink the winner",
    destContentionItTimeout(),
    async () => {
      const root = tempDir("scope-3908-complete-");
      for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
        mkdirSync(join(root, "xbrief", folder), { recursive: true });
      }
      const name = "2026-01-01-race-complete.xbrief.json";
      const source = join(root, "xbrief", "active", name);
      const dest = join(root, "xbrief", "completed", name);
      writeFileSync(
        source,
        formatBriefJson({
          xBRIEFInfo: { version: "0.8" },
          plan: { title: "T", status: "running", items: [] },
        }),
        "utf8",
      );
      const workerDir = tempDir("scope-3908-complete-worker-");
      const transitionAbs = fileURLToPath(new URL("./transition.ts", import.meta.url));
      const workerFile = join(workerDir, "complete-worker.ts");
      writeFileSync(
        workerFile,
        `import { existsSync, writeFileSync } from "node:fs";
import { runTransition } from ${JSON.stringify(transitionAbs)};
const file = process.env.SCOPE_3908_FILE ?? "";
const ready = process.env.SCOPE_3908_READY ?? "";
const go = process.env.SCOPE_3908_GO ?? "";
const entered = process.env.SCOPE_3908_ENTERED ?? "";
writeFileSync(ready, "1");
const start = Date.now();
while (!existsSync(go)) {
  if (Date.now() - start > 15000) {
    process.stderr.write("barrier-timeout\\n");
    process.exit(3);
  }
}
writeFileSync(entered, "1");
const result = runTransition("complete", file, new Date("2026-10-15T12:00:00.000Z"));
process.stdout.write(JSON.stringify(result) + "\\n");
`,
        "utf8",
      );
      const barrierDir = tempDir("scope-3908-complete-barrier-");
      const readyA = join(barrierDir, "ready-a");
      const readyB = join(barrierDir, "ready-b");
      const go = join(barrierDir, "go");
      const enteredA = join(barrierDir, "entered-a");
      const enteredB = join(barrierDir, "entered-b");
      const workerA = spawnWorker({
        workerFile,
        env: {
          SCOPE_3908_FILE: source,
          SCOPE_3908_READY: readyA,
          SCOPE_3908_GO: go,
          SCOPE_3908_ENTERED: enteredA,
        },
      });
      const workerB = spawnWorker({
        workerFile,
        env: {
          SCOPE_3908_FILE: source,
          SCOPE_3908_READY: readyB,
          SCOPE_3908_GO: go,
          SCOPE_3908_ENTERED: enteredB,
        },
      });
      await waitForPath(readyA, 10_000);
      await waitForPath(readyB, 10_000);
      writeFileSync(go, "1");
      await waitForPath(enteredA, 10_000);
      await waitForPath(enteredB, 10_000);
      const [a, b] = await Promise.all([workerA, workerB]);
      expect(a.code).toBe(0);
      expect(b.code).toBe(0);
      const ra = JSON.parse(a.stdout.trim()) as { ok: boolean; message: string };
      const rb = JSON.parse(b.stdout.trim()) as { ok: boolean; message: string };
      const oks = [ra, rb].filter((r) => r.ok);
      const fails = [ra, rb].filter((r) => !r.ok);
      expect(oks.length).toBeGreaterThanOrEqual(1);
      expect(existsSync(enteredA)).toBe(true);
      expect(existsSync(enteredB)).toBe(true);
      const destBytes = readFileSync(dest, "utf8");
      expect(destBytes.length).toBeGreaterThan(0);
      const parsed = JSON.parse(destBytes) as { plan: { status: string } };
      expect(parsed.plan.status).toBe("completed");
      for (const fail of fails) {
        expect(readFileSync(dest, "utf8")).toBe(destBytes);
        expect(fail.message.length).toBeGreaterThan(0);
      }
    },
  );
});
