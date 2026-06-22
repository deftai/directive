import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBinary } from "../scm/binary.js";
import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";
import type { SubprocessTriple } from "./types.js";

export interface CaptureExecResult {
  readonly returncode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** UTF-8-safe subprocess capture via spawnSync (no shell) — mirrors #1366. */
export function captureExec(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
): CaptureExecResult {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: SUBPROCESS_MAX_BUFFER,
    env: process.env,
  });

  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        returncode: -1,
        stdout: "",
        stderr: `executable not found: ${executable}`,
      };
    }
    if (code === "ETIMEDOUT") {
      return {
        returncode: -1,
        stdout: "",
        stderr: `timed out after ${timeoutMs}ms`,
      };
    }
    return {
      returncode: -1,
      stdout: "",
      stderr: String(result.error.message ?? result.error),
    };
  }

  return {
    returncode: result.status ?? -1,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function cliScriptPath(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../../cli/dist", `${name}.js`);
}

export interface RunProtectedCheckOptions {
  readonly nodeExecutable?: string;
  readonly timeout?: number;
}

/** Invoke pr-protected-issues CLI and return (returncode, stdout, stderr). */
export function runProtectedCheck(
  prNumber: number,
  repo: string | null,
  protectedIssues: readonly number[],
  options: RunProtectedCheckOptions = {},
): SubprocessTriple {
  const node = options.nodeExecutable ?? process.execPath;
  const cmd: string[] = [
    cliScriptPath("pr-protected-issues"),
    String(prNumber),
    "--protected",
    protectedIssues.map(String).join(","),
  ];
  if (repo) {
    cmd.push("--repo", repo);
  }
  const result = captureExec(node, cmd, (options.timeout ?? 60) * 1000);
  return [result.returncode, result.stdout, result.stderr];
}

export interface RunMonitorOptions {
  readonly nodeExecutable?: string;
  readonly timeout?: number;
}

/** Invoke pr-monitor CLI with --json and return (returncode, stdout, stderr). */
export function runMonitor(
  prNumber: number,
  repo: string,
  capMinutes: number,
  options: RunMonitorOptions = {},
): SubprocessTriple {
  const node = options.nodeExecutable ?? process.execPath;
  const timeoutSec = options.timeout ?? capMinutes * 60 + 60;
  const cmd: string[] = [
    cliScriptPath("pr-monitor"),
    String(prNumber),
    "--repo",
    repo,
    "--cap-minutes",
    String(capMinutes),
    "--json",
  ];
  const result = captureExec(node, cmd, timeoutSec * 1000);
  return [result.returncode, result.stdout, result.stderr];
}

export interface RunGhMergeOptions {
  readonly timeout?: number;
}

/** Invoke ``gh pr merge --squash --delete-branch --admin``. */
export function runGhMerge(
  prNumber: number,
  repo: string | null,
  options: RunGhMergeOptions = {},
): SubprocessTriple {
  const timeoutSec = options.timeout ?? 120;
  let binary: string;
  try {
    binary = resolveBinary();
  } catch {
    return [-1, "", "gh CLI not found. Install GitHub CLI."];
  }
  const args = ["pr", "merge", String(prNumber), "--squash", "--delete-branch", "--admin"];
  if (repo) {
    args.push("--repo", repo);
  }
  const result = captureExec(binary, args, timeoutSec * 1000);
  if (result.returncode === -1) {
    if (result.stderr.includes("timed out after")) {
      return [-1, "", `gh pr merge timed out after ${timeoutSec}s`];
    }
    if (result.stderr.includes("executable not found")) {
      return [-1, "", "gh CLI not found. Install GitHub CLI."];
    }
  }
  return [result.returncode, result.stdout, result.stderr];
}
