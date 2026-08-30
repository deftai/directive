import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate as evaluateCloseoutAttestable } from "../pr-closeout-attestable/evaluate.js";
import { resolveBinaryForArgv } from "../scm/call-shape.js";
import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";
import type { SubprocessTriple } from "./types.js";

export interface CaptureExecResult {
  readonly returncode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CaptureExecOptions {
  /**
   * Stream the child's stderr straight to the parent's stderr (live) instead of
   * capturing it. Used for long polls so the per-poll heartbeat is visible in
   * real time rather than buffered until the subprocess exits (#2260). When set,
   * the returned `stderr` is empty because it was not captured.
   */
  readonly inheritStderr?: boolean;
  /** Environment for the child (defaults to `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
}

/** UTF-8-safe subprocess capture via spawnSync (no shell) — mirrors #1366. */
export function captureExec(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  options: CaptureExecOptions = {},
): CaptureExecResult {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", options.inheritStderr === true ? "inherit" : "pipe"],
    maxBuffer: SUBPROCESS_MAX_BUFFER,
    env: options.env ?? process.env,
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

/**
 * Resolve a CLI entry script for subprocess spawn (#2615).
 *
 * Published npm layout nests `@deftai/directive-core` under `@deftai/directive`,
 * so the old `../../../cli/dist` relative path resolved to a non-existent
 * `@deftai/cli` sibling. Prefer the published package root, then monorepo path,
 * then nested `@deftai/directive/dist`.
 */
export function cliScriptPath(name: string): string {
  const script = `${name}.js`;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates: string[] = [];

  try {
    const require = createRequire(import.meta.url);
    // package.json is not an exported subpath under @deftai/directive exports (#2667).
    const mainEntry = require.resolve("@deftai/directive");
    candidates.push(resolve(dirname(mainEntry), script));
  } catch {
    // Core does not declare a runtime dependency on the CLI package; ignore.
  }

  // Monorepo: packages/core/dist/pr-wait-mergeable -> packages/cli/dist
  candidates.push(resolve(here, "../../../cli/dist", script));
  // npm hoisted: .../@deftai/directive-core/dist/... -> .../@deftai/directive/dist
  candidates.push(resolve(here, "../../../directive/dist", script));
  // npm nested: .../directive/node_modules/@deftai/directive-core/dist/... -> .../directive/dist
  candidates.push(resolve(here, "../../../../dist", script));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // ENOENT path for actionable errors — monorepo layout is the stable fallback.
  return resolve(here, "../../../cli/dist", script);
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
  const scriptPath = cliScriptPath("pr-protected-issues");
  if (!existsSync(scriptPath)) {
    return [2, "", `protected-check script not found: ${scriptPath}`];
  }
  const node = options.nodeExecutable ?? process.execPath;
  const cmd: string[] = [
    scriptPath,
    String(prNumber),
    "--protected",
    protectedIssues.map(String).join(","),
  ];
  if (repo) {
    cmd.push("--repo", repo);
  }
  const result = captureExec(node, cmd, (options.timeout ?? 60) * 1000, {
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  return [result.returncode, result.stdout, result.stderr];
}

/**
 * Merge-time closeout attestability gate (#3781). In-process: the evaluator lives
 * in this package, and a subprocess hop would only add a script-path failure mode
 * to a gate that must fail closed.
 */
export function runCloseoutAttestableCheck(
  prNumber: number,
  repo: string | null,
  projectRoot: string,
): SubprocessTriple {
  const result = evaluateCloseoutAttestable(projectRoot, prNumber, { repo });
  const text = result.message.length > 0 ? `${result.message}\n` : "";
  return result.code === 0 ? [0, text, ""] : [result.code, "", text];
}

export interface RunMonitorOptions {
  readonly nodeExecutable?: string;
  readonly timeout?: number;
  /**
   * Project root for plan.policy.review.minGreptileConfidence when the
   * cascade cwd is not the monitored project (#3095 residual / #3102).
   * Defaults to process.cwd() when omitted.
   */
  readonly projectRoot?: string;
}

/** Invoke pr-monitor CLI with --json and return (returncode, stdout, stderr). */
export function runMonitor(
  prNumber: number,
  repo: string,
  capMinutes: number,
  options: RunMonitorOptions = {},
): SubprocessTriple {
  const scriptPath = cliScriptPath("pr-monitor");
  if (!existsSync(scriptPath)) {
    return [2, "", `monitor script not found: ${scriptPath}`];
  }
  const node = options.nodeExecutable ?? process.execPath;
  const timeoutSec = options.timeout ?? capMinutes * 60 + 60;
  const projectRoot = options.projectRoot ?? process.cwd();
  const cmd: string[] = [
    scriptPath,
    String(prNumber),
    "--repo",
    repo,
    "--cap-minutes",
    String(capMinutes),
    "--project-root",
    projectRoot,
    "--json",
  ];
  // Stream the monitor's per-poll heartbeat live (a buffered poll looks like a
  // hang, #2260) and suppress Node deprecation/engine warning noise so it never
  // leaks onto the captured JSON stream or the final result line (#2240-class).
  const result = captureExec(node, cmd, timeoutSec * 1000, {
    inheritStderr: true,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  return [result.returncode, result.stdout, result.stderr];
}

export interface RunGhMergeOptions {
  readonly timeout?: number;
  /**
   * Pin merge to this exact head SHA via `gh pr merge --match-head-commit`
   * (#3235 TOCTOU: refuse merge if PR head advanced after approval gate).
   */
  readonly matchHeadCommit?: string | null;
}

/** Invoke ``gh pr merge --squash --delete-branch --admin`` [``--match-head-commit``]. */
export function runGhMerge(
  prNumber: number,
  repo: string | null,
  options: RunGhMergeOptions = {},
): SubprocessTriple {
  const timeoutSec = options.timeout ?? 120;
  const args = ["pr", "merge", String(prNumber), "--squash", "--delete-branch", "--admin"];
  let binary: string;
  try {
    binary = resolveBinaryForArgv("pr", args.slice(1));
  } catch {
    return [-1, "", "gh CLI not found. Install GitHub CLI."];
  }
  if (repo) {
    args.push("--repo", repo);
  }
  const matchHead =
    typeof options.matchHeadCommit === "string" && options.matchHeadCommit.trim().length > 0
      ? options.matchHeadCommit.trim()
      : null;
  if (matchHead !== null) {
    args.push("--match-head-commit", matchHead);
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
