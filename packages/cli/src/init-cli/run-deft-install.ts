import { spawnSync } from "node:child_process";
import type { DispatchIo } from "../dispatch.js";
import {
  cliPackageRoot,
  missingBinaryMessage,
  type ResolveBinaryOptions,
  resolveBundledDeftInstallBinary,
} from "./resolve-binary.js";

const SUBPROCESS_MAX_BUFFER = 64 * 1024 * 1024;

export interface BinaryRunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type RunBinaryFn = (binary: string, args: readonly string[], cwd: string) => BinaryRunResult;

/** Safe subprocess capture (#1366): utf-8 text mode with replace semantics. */
export function defaultRunBinary(
  binary: string,
  args: readonly string[],
  cwd: string,
): BinaryRunResult {
  const result = spawnSync(binary, [...args], {
    cwd,
    env: process.env,
    encoding: "utf8",
    maxBuffer: SUBPROCESS_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let status = result.status;
  let stderr = typeof result.stderr === "string" ? result.stderr : "";
  if (status === null) {
    if (result.signal !== null && result.signal !== undefined) {
      status = 128;
    } else if (result.error) {
      status = 2;
      if (stderr.trim().length === 0) {
        stderr = result.error.message;
      }
    } else {
      status = 0;
    }
  }

  return {
    status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr,
  };
}

function writeCaptured(text: string, write: (chunk: string) => void): void {
  if (text.length === 0) return;
  write(text.endsWith("\n") ? text : `${text}\n`);
}

export interface RunDeftInstallOptions {
  verb: "init" | "update";
  canonicalArgv: readonly string[];
  userArgv?: readonly string[];
  io: DispatchIo;
  cwd?: string;
  resolveBinary?: (options?: ResolveBinaryOptions) => string | null;
  resolveBinaryOptions?: ResolveBinaryOptions;
  runBinary?: RunBinaryFn;
}

/** Shell out to bundled deft-install with canonical argv and map exit codes. */
export function runDeftInstall(options: RunDeftInstallOptions): number {
  const resolveBinary = options.resolveBinary ?? resolveBundledDeftInstallBinary;
  const resolveOptions = options.resolveBinaryOptions ?? {};
  const binary = resolveBinary(resolveOptions);

  if (binary === null) {
    const packageRoot =
      resolveOptions.packageRoot ?? cliPackageRoot(resolveOptions.moduleUrl ?? import.meta.url);
    const platform = resolveOptions.platform ?? process.platform;
    const arch = resolveOptions.arch ?? process.arch;
    options.io.writeErr(`${missingBinaryMessage(options.verb, packageRoot, platform, arch)}\n`);
    return 2;
  }

  const args = [...options.canonicalArgv, ...(options.userArgv ?? [])];
  const cwd = options.cwd ?? process.cwd();
  const runBinary = options.runBinary ?? defaultRunBinary;
  const result = runBinary(binary, args, cwd);

  writeCaptured(result.stdout, options.io.writeOut);
  writeCaptured(result.stderr, options.io.writeErr);
  return result.status === 0 ? 0 : result.status;
}
