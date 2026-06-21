import { existsSync, mkdirSync } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
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

/**
 * Resolve the compiled worker-thread bootstrap path, preferring the sibling
 * file when running from source and falling back to the dist mirror.
 */
function resolveWorkerPath(): string {
  const localWorker = fileURLToPath(new URL("./entrypoint-worker-thread.js", import.meta.url));
  const srcSegment = `${sep}src${sep}`;
  const srcIdx = localWorker.indexOf(srcSegment);
  const distWorker =
    srcIdx === -1
      ? localWorker
      : `${localWorker.slice(0, srcIdx)}${sep}dist${sep}${localWorker.slice(srcIdx + srcSegment.length)}`;
  return existsSync(localWorker) ? localWorker : distWorker;
}

/**
 * Synchronous worker-backed entrypoint runner (#1864).
 *
 * The earlier `runPromiseSync` deadlocked: it blocked the main thread with
 * `Atomics.wait` while waiting on a Promise whose only settle paths
 * (`worker.on("message")`, `worker.on("error")`, the timeout `setTimeout`)
 * were main-thread event-loop callbacks -- which a blocked event loop can
 * never run, so the `Atomics.notify` microtask never fired and the wait
 * (and the timeout) hung forever.
 *
 * The fix relies on a CROSS-THREAD wake: the worker writes its result to a
 * transferred MessagePort and calls `Atomics.notify` from the worker thread,
 * which wakes the main thread's `Atomics.wait` without needing the event
 * loop. `Atomics.wait`'s own `timeoutMs` is the working timeout backstop
 * (covering the rare worker-load-failure-before-notify case), and
 * `receiveMessageOnPort` reads the queued result synchronously.
 */
export function runEntrypointWorkerSync(
  kind: "release" | "rollback" | "test",
  argv: string[],
  cloneDir: string,
  timeoutMs: number,
  testBehavior?: "ok" | "hang" | "throw",
): { code: number; stdout: string; stderr: string } {
  const workerPath = resolveWorkerPath();
  const signal = new Int32Array(new SharedArrayBuffer(4)); // 0 = pending, 1 = settled
  const channel = new MessageChannel();
  let worker: Worker;
  try {
    worker = new Worker(workerPath, {
      workerData: { kind, argv, cloneDir, signal, port: channel.port2, testBehavior },
      transferList: [channel.port2],
    });
  } catch (err) {
    return {
      code: EXIT_VIOLATION,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }

  // Crash guard: a worker 'error' event (async module-load failure, or a
  // post-timeout throw when the worker posts to the already-closed port) is
  // re-thrown as an uncaught exception if no listener is attached. We can't act
  // on it here -- this function runs synchronously while the event loop is
  // blocked in Atomics.wait, so an 'error' event can only be delivered on a
  // later tick after we've already returned -- but registering a no-op listener
  // keeps a late worker failure from crashing the whole process (#1864 / #1865).
  worker.on("error", () => {});

  try {
    const waitResult = Atomics.wait(signal, 0, 0, timeoutMs);
    if (waitResult === "timed-out") {
      return {
        code: ENTRYPOINT_TIMEOUT_EXIT_CODE,
        stdout: "",
        stderr: `${kind} timed out after ${timeoutMs / 1000}s`,
      };
    }
    const received = receiveMessageOnPort(channel.port1);
    if (received === undefined) {
      return { code: EXIT_VIOLATION, stdout: "", stderr: "worker produced no result" };
    }
    return received.message as { code: number; stdout: string; stderr: string };
  } finally {
    channel.port1.close();
    void worker.terminate();
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
  const workerPath = resolveWorkerPath();

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

function callReleaseEntrypointWorkerBacked(
  kind: "release" | "rollback",
  argv: string[],
  cloneDir: string,
  timeout: number,
): [number, string] {
  const timeoutMs = Math.max(1, Math.floor(timeout * 1000));
  const result = runEntrypointWorkerSync(kind, argv, cloneDir, timeoutMs);
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
