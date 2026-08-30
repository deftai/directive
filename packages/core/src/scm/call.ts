import { spawnSync } from "node:child_process";
import { resolveCaptureFailureStderr, SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";
import { defaultWhich, type WhichFn } from "./binary.js";
import { classifyScmArgv, resolveBinaryForRole } from "./call-shape.js";
import { SUPPORTED_CALL_SOURCES } from "./constants.js";
import { pyRepr } from "./py-format.js";
import { formatScmSpawnDiagnostic, isAvailabilitySpawnFailure } from "./spawn-status.js";

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
  readonly whichFn?: WhichFn;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
}

/**
 * Source-aware SCM invocation -- partial down-payment on #445 / #935 Workstream 6.
 * Mirrors `scripts/scm.py::call`.
 *
 * Binary absence still throws ScmStubError via resolveBinaryForRole with the
 * #2275 diagnostic. Full auth readiness is enforced at SCM CLI entry points
 * (`scm/main`, issue-ingest, reconcile-issues) via requireScmReady — not on
 * every call() — so unit tests that inject binary/seams stay hermetic.
 *
 * Call-shape selection (#3737): ghx only for single-path GET. An explicit
 * `binary` override skips selection and spawn-failure fallback.
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

  const whichFn = options.whichFn ?? defaultWhich;
  const role = classifyScmArgv(verb, args ?? []);
  const explicitBinary = options.binary;
  let resolved: string = explicitBinary ?? resolveBinaryForRole(role, whichFn);
  const extra = args ?? [];
  const captureOutput = options.captureOutput ?? true;
  const timeoutMs = options.timeout !== undefined ? Math.round(options.timeout * 1000) : undefined;

  const spawnOnce = (bin: string) =>
    spawnSync(bin, [verb, ...extra], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      input: options.input,
      encoding: (options.text ?? true) ? "utf8" : undefined,
      timeout: timeoutMs,
      maxBuffer: SUBPROCESS_MAX_BUFFER,
      stdio: captureOutput ? ["pipe", "pipe", "pipe"] : "inherit",
    });

  let result = spawnOnce(resolved);
  if (
    explicitBinary === undefined &&
    role === "cached-get" &&
    resolved === "ghx" &&
    isAvailabilitySpawnFailure({
      status: result.status,
      error: result.error,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
    }) &&
    whichFn("gh") !== null
  ) {
    resolved = "gh";
    result = spawnOnce(resolved);
  }

  const argv = [resolved, verb, ...extra];
  const captured = typeof result.stderr === "string" ? result.stderr : "";
  let stderr = resolveCaptureFailureStderr({
    captured,
    status: result.status,
    message: result.error?.message,
  });
  if (
    isAvailabilitySpawnFailure({
      status: result.status,
      error: result.error,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: captured,
    }) &&
    stderr.trim().length === 0
  ) {
    stderr = formatScmSpawnDiagnostic(resolved, result.status, stderr, result.error);
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
