import { existsSync, mkdirSync } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { cmdRelease } from "../release/main.js";
import {
  ENTRYPOINT_TIMEOUT_EXIT_CODE,
  EXIT_VIOLATION,
  RELEASE_ENTRYPOINT_TIMEOUT_SECONDS,
  ROLLBACK_ENTRYPOINT_TIMEOUT_SECONDS,
} from "./constants.js";
import { rollbackMain } from "./rollback-bridge.js";
import type { E2ESeams, EntrypointFn } from "./types.js";

let activeRestoreOwner: symbol | null = null;

/** @internal Test hook for restore-owner branch coverage. */
export function restoreProcessStateForTest(
  restoreOwner: symbol,
  oldCwd: string,
  oldProjectRoot: string | undefined,
): void {
  restoreProcessState(restoreOwner, oldCwd, oldProjectRoot);
}

function restoreProcessState(
  restoreOwner: symbol,
  oldCwd: string,
  oldProjectRoot: string | undefined,
): void {
  if (activeRestoreOwner !== restoreOwner) {
    return;
  }
  activeRestoreOwner = null;
  process.chdir(oldCwd);
  if (oldProjectRoot === undefined) {
    delete process.env.DEFT_PROJECT_ROOT;
  } else {
    process.env.DEFT_PROJECT_ROOT = oldProjectRoot;
  }
}

function activateProcessState(restoreOwner: symbol, cloneDir: string): boolean {
  activeRestoreOwner = restoreOwner;
  process.env.DEFT_PROJECT_ROOT = cloneDir;
  mkdirSync(cloneDir, { recursive: true });
  process.chdir(cloneDir);
  return true;
}

function runEntrypointWithCapture(entrypoint: EntrypointFn, argv: string[]): [number, string] {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const prevStdout = process.stdout.write.bind(process.stdout);
  const prevStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    const code = entrypoint(argv);
    const output = stderrChunks.join("") || stdoutChunks.join("");
    return [code || 0, output];
  } catch (exc) {
    const message = exc instanceof Error ? `${exc.name}: ${exc.message}` : String(exc);
    const captured = stderrChunks.join("");
    const stderrValue = captured ? `${captured}\n${message}` : message;
    return [EXIT_VIOLATION, stderrValue || stdoutChunks.join("")];
  } finally {
    process.stdout.write = prevStdout;
    process.stderr.write = prevStderr;
  }
}

/** @internal Exported for unit tests that mock worker-backed timeouts. */
export async function runEntrypointWorker(
  kind: "release" | "rollback" | "test",
  argv: string[],
  cloneDir: string,
  timeoutMs: number,
  testBehavior?: "hang" | "throw",
): Promise<{ code: number; stdout: string; stderr: string }> {
  const localWorker = fileURLToPath(new URL("./entrypoint-worker-thread.js", import.meta.url));
  const srcSegment = `${sep}src${sep}`;
  const srcIdx = localWorker.indexOf(srcSegment);
  const distWorker =
    srcIdx === -1
      ? localWorker
      : `${localWorker.slice(0, srcIdx)}${sep}dist${sep}${localWorker.slice(srcIdx + srcSegment.length)}`;
  const workerPath = existsSync(localWorker) ? localWorker : distWorker;

  return new Promise((resolvePromise) => {
    let worker: Worker;
    try {
      worker = new Worker(workerPath, {
        workerData: { kind, argv, cloneDir, testBehavior },
      });
    } catch (err) {
      resolvePromise({
        code: EXIT_VIOLATION,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    let settled = false;
    const finish = (payload: { code: number; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolvePromise(payload);
    };
    const timer = setTimeout(() => {
      finish({
        code: ENTRYPOINT_TIMEOUT_EXIT_CODE,
        stdout: "",
        stderr: `${kind} timed out after ${timeoutMs / 1000}s`,
      });
    }, timeoutMs);
    worker.on("message", (msg: { code: number; stdout: string; stderr: string }) => finish(msg));
    worker.on("error", (err) =>
      finish({
        code: EXIT_VIOLATION,
        stdout: "",
        stderr: err instanceof Error ? err.message : "worker error",
      }),
    );
  });
}

function runPromiseSync<T>(promise: Promise<T>): T {
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  type Outcome = { ok: true; value: T } | { ok: false; error: unknown };
  const box: { outcome?: Outcome } = {};
  void promise.then(
    (value) => {
      box.outcome = { ok: true, value };
      Atomics.store(ia, 0, 1);
      Atomics.notify(ia, 0);
    },
    (error) => {
      box.outcome = { ok: false, error };
      Atomics.store(ia, 0, 1);
      Atomics.notify(ia, 0);
    },
  );
  Atomics.wait(ia, 0, 0);
  const outcome = box.outcome;
  if (outcome === undefined) {
    throw new Error("promise sync wait failed");
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

function callReleaseEntrypointWorkerBacked(
  kind: "release" | "rollback",
  argv: string[],
  cloneDir: string,
  timeout: number,
): [number, string] {
  const timeoutMs = Math.max(1, Math.floor(timeout * 1000));
  const result = runPromiseSync(runEntrypointWorker(kind, argv, cloneDir, timeoutMs));
  return [result.code, result.stderr || result.stdout];
}

/** Run a release entrypoint in-process with subprocess-style bounds. */
export function callReleaseEntrypoint(
  entrypoint: EntrypointFn,
  argv: string[],
  cloneDir: string,
  timeout: number = RELEASE_ENTRYPOINT_TIMEOUT_SECONDS,
): [number, string] {
  if (entrypoint === defaultReleaseEntrypoint) {
    return callReleaseEntrypointWorkerBacked("release", argv, cloneDir, timeout);
  }
  if (entrypoint === defaultRollbackEntrypoint) {
    return callReleaseEntrypointWorkerBacked("rollback", argv, cloneDir, timeout);
  }

  const oldCwd = process.cwd();
  const oldProjectRoot = process.env.DEFT_PROJECT_ROOT;
  const restoreOwner = Symbol("entrypoint-restore");

  try {
    activateProcessState(restoreOwner, cloneDir);
    return runEntrypointWithCapture(entrypoint, argv);
  } finally {
    restoreProcessState(restoreOwner, oldCwd, oldProjectRoot);
  }
}

/** Async variant with timeout support (used for hang / worker-backed entrypoints). */
export async function callReleaseEntrypointTimed(
  kind: "release" | "rollback" | "test",
  argv: string[],
  cloneDir: string,
  timeout: number,
  testBehavior?: "hang" | "throw",
): Promise<[number, string]> {
  const oldCwd = process.cwd();
  const oldProjectRoot = process.env.DEFT_PROJECT_ROOT;
  const restoreOwner = Symbol("entrypoint-restore");
  try {
    activateProcessState(restoreOwner, cloneDir);
    const timeoutMs = Math.max(1, Math.floor(timeout * 1000));
    const result = await runEntrypointWorker(kind, argv, cloneDir, timeoutMs, testBehavior);
    return [result.code, result.stderr || result.stdout];
  } finally {
    restoreProcessState(restoreOwner, oldCwd, oldProjectRoot);
  }
}

export function defaultReleaseEntrypoint(argv: string[]): number {
  return cmdRelease(argv);
}

export function defaultRollbackEntrypoint(argv: string[]): number {
  return rollbackMain(argv);
}

export function dispatchTaskRelease(
  cloneDir: string,
  version: string,
  repo: string,
  seams: E2ESeams = {},
): [boolean, string] {
  const argv = [version, "--repo", repo, "--skip-ci", "--skip-build", "--allow-vbrief-drift"];
  if (seams.releaseEntrypoint) {
    const code = seams.releaseEntrypoint(argv);
    if (code !== 0) {
      return [false, `release.py failed (exit ${code}): `];
    }
    return [true, `release.py ${version} --repo ${repo} (draft) ran clean`];
  }
  const entrypoint = defaultReleaseEntrypoint;
  const [code, output] = callReleaseEntrypoint(
    entrypoint,
    argv,
    cloneDir,
    RELEASE_ENTRYPOINT_TIMEOUT_SECONDS,
  );
  if (code !== 0) {
    return [false, `release.py failed (exit ${code}): ${output.trim()}`];
  }
  return [true, `release.py ${version} --repo ${repo} (draft) ran clean`];
}

export function dispatchTaskReleaseRollback(
  cloneDir: string,
  version: string,
  repo: string,
  seams: E2ESeams = {},
): [boolean, string] {
  const argv = [version, "--repo", repo];
  if (seams.rollbackEntrypoint) {
    const code = seams.rollbackEntrypoint(argv);
    if (code !== 0) {
      return [false, `release_rollback.py failed (exit ${code}): `];
    }
    return [true, `release_rollback.py ${version} --repo ${repo} ran clean`];
  }
  const entrypoint = defaultRollbackEntrypoint;
  const [code, output] = callReleaseEntrypoint(
    entrypoint,
    argv,
    cloneDir,
    ROLLBACK_ENTRYPOINT_TIMEOUT_SECONDS,
  );
  if (code !== 0) {
    return [false, `release_rollback.py failed (exit ${code}): ${output.trim()}`];
  }
  return [true, `release_rollback.py ${version} --repo ${repo} ran clean`];
}
