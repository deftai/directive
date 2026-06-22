import { cmdDoctor } from "../doctor/main.js";
import { evaluate } from "../preflight-cache/evaluate.js";

export const ENTRYPOINT_TIMEOUT_SECONDS = 300;
export const ENTRYPOINT_TIMEOUT_EXIT_CODE = 124;

export type RitualEntrypointFn = (argv: readonly string[]) => number;

/** Run an in-process ritual entrypoint with stdout/stderr capture. */
export function callMain(
  mainFn: RitualEntrypointFn,
  argv: readonly string[],
  _options: { label?: string } = {},
): { code: number; stdout: string; stderr: string } {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const prevStdout = process.stdout.write.bind(process.stdout);
  const prevStderr = process.stderr.write.bind(process.stderr);
  const captureWrite =
    (chunks: string[]) =>
    (
      chunk: string | Uint8Array,
      encoding?: BufferEncoding | ((err?: Error | null) => void),
      callback?: (err?: Error | null) => void,
    ): boolean => {
      chunks.push(String(chunk));
      const cb = typeof encoding === "function" ? encoding : callback;
      if (typeof cb === "function") {
        cb();
      }
      return true;
    };
  process.stdout.write = captureWrite(stdoutChunks) as typeof process.stdout.write;
  process.stderr.write = captureWrite(stderrChunks) as typeof process.stderr.write;

  try {
    const exitCode = mainFn(argv);
    return { code: exitCode || 0, stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
  } catch (exc) {
    const message = exc instanceof Error ? `${exc.name}: ${exc.message}` : String(exc);
    const captured = stderrChunks.join("");
    const stderr = captured ? `${captured}\n${message}` : message;
    return { code: 2, stdout: stdoutChunks.join(""), stderr };
  } finally {
    process.stdout.write = prevStdout;
    process.stderr.write = prevStderr;
  }
}

function parseProjectRoot(argv: readonly string[]): string {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-root") {
      return argv[i + 1] ?? ".";
    }
    if (arg?.startsWith("--project-root=")) {
      return arg.slice("--project-root=".length);
    }
  }
  return ".";
}

/** CLI-shaped cache-fresh entrypoint (mirrors scripts/preflight_cache.py main). */
export function runCacheFreshMain(argv: readonly string[]): number {
  const projectRoot = parseProjectRoot(argv);
  const allowMissingBootstrap = argv.includes("--allow-missing-bootstrap");
  const quiet = argv.includes("--quiet");
  const result = evaluate(projectRoot, { allowMissingBootstrap });
  if (result.code === 0) {
    if (!quiet) {
      if (result.message.startsWith("⚠")) {
        process.stderr.write(`${result.message}\n`);
      } else {
        process.stdout.write(`${result.message}\n`);
      }
    }
  } else {
    process.stderr.write(`${result.message}\n`);
  }
  return result.code;
}

/** Default gated-tier runner: in-process doctor + cache-fresh (mirrors verify_session_ritual.py). */
export function defaultRitualRunner(
  command: readonly string[],
  projectRoot: string,
): { code: number; stdout: string; stderr: string } {
  const [verb, ...rest] = command;
  if (verb === "doctor") {
    return callMain((argv) => cmdDoctor(argv), ["--project-root", projectRoot, ...rest]);
  }
  if (verb === "verify:cache-fresh") {
    return callMain(runCacheFreshMain, [
      "--allow-missing-bootstrap",
      "--project-root",
      projectRoot,
      ...rest,
    ]);
  }
  const label = verb ?? "entrypoint";
  return { code: 2, stdout: "", stderr: `unknown session ritual command: ${label}` };
}
