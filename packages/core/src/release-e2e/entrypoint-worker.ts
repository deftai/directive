import { cmdRelease } from "../release/main.js";
import { rollbackMain } from "./rollback-bridge.js";

export interface WorkerEntrypointData {
  kind: "release" | "rollback" | "test";
  argv: string[];
  cloneDir: string;
  testBehavior?: "ok" | "hang" | "throw";
}

export interface WorkerEntrypointResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runWorkerEntrypoint(data: WorkerEntrypointData): WorkerEntrypointResult {
  process.env.DEFT_PROJECT_ROOT = data.cloneDir;

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

  let code = 0;
  let error: string | undefined;
  try {
    if (data.kind === "release") {
      code = cmdRelease(data.argv);
    } else if (data.kind === "rollback") {
      code = rollbackMain(data.argv);
    } else if (data.testBehavior === "hang") {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_000);
      code = 0;
    } else if (data.testBehavior === "throw") {
      throw new Error("boom");
    }
  } catch (exc) {
    const message = exc instanceof Error ? `${exc.name}: ${exc.message}` : String(exc);
    const captured = stderrChunks.join("");
    error = captured ? `${captured}\n${message}` : message;
    code = 1;
  } finally {
    process.stdout.write = prevStdout;
    process.stderr.write = prevStderr;
  }

  return {
    code: error ? 1 : code || 0,
    stdout: stdoutChunks.join(""),
    stderr: error ?? stderrChunks.join(""),
  };
}
