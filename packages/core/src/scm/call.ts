import { spawnSync } from "node:child_process";
import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";
import { resolveBinary } from "./binary.js";
import { SUPPORTED_CALL_SOURCES } from "./constants.js";
import { pyRepr } from "./py-format.js";

/** Mirrors Python `subprocess.CompletedProcess`. */
export interface CompletedProcess {
  readonly args: readonly string[];
  readonly returncode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CallOptions {
  readonly check?: boolean;
  readonly captureOutput?: boolean;
  readonly text?: boolean;
  readonly timeout?: number;
  readonly cwd?: string;
  readonly binary?: string;
  readonly whichFn?: Parameters<typeof resolveBinary>[0];
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
}

/**
 * Source-aware SCM invocation -- partial down-payment on #445 / #935 Workstream 6.
 * Mirrors `scripts/scm.py::call`.
 *
 * Binary absence still throws ScmStubError via resolveBinary with the #2275
 * diagnostic. Full auth readiness is enforced at SCM CLI entry points
 * (`scm/main`, issue-ingest, reconcile-issues) via requireScmReady — not on
 * every call() — so unit tests that inject binary/seams stay hermetic.
 */
export function call(
  source: string,
  verb: string,
  args: readonly string[] | null = null,
  options: CallOptions = {},
): CompletedProcess {
  if (!SUPPORTED_CALL_SOURCES.includes(source as (typeof SUPPORTED_CALL_SOURCES)[number])) {
    throw new Error(
      `source=${pyRepr(source)} not yet supported; ` +
        "see #445 / #935 Workstream 6 for the abstraction.",
    );
  }

  const resolved: string = options.binary ?? resolveBinary(options.whichFn);

  const argv = [resolved, verb, ...(args ?? [])];
  const captureOutput = options.captureOutput ?? true;
  const timeoutMs = options.timeout !== undefined ? Math.round(options.timeout * 1000) : undefined;

  const result = spawnSync(resolved, [verb, ...(args ?? [])], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    input: options.input,
    encoding: (options.text ?? true) ? "utf8" : undefined,
    timeout: timeoutMs,
    maxBuffer: SUBPROCESS_MAX_BUFFER,
    stdio: captureOutput ? ["pipe", "pipe", "pipe"] : "inherit",
  });

  let stderr = typeof result.stderr === "string" ? result.stderr : "";
  // A spawn-level failure (ENOBUFS past maxBuffer, timeout kill) yields a null
  // status and empty stderr; surface error.message so callers never report a
  // bare exit 1 with no reason (#1867 / #3903).
  if (result.status === null && result.error && stderr.trim().length === 0) {
    stderr = result.error.message;
  }

  if (options.check && result.status !== 0) {
    const error = new Error(stderr || `Process exited with code ${result.status}`);
    throw error;
  }

  return {
    args: argv,
    returncode: result.status ?? 1,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr,
  };
}
