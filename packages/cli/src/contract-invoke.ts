/**
 * Spawn the runtime entry as a separate node process (AC4.2).
 * Never via PATH; never a download substitute.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  ENV_LAUNCHER_VERSION,
  ENV_PROJECT_ROOT,
  EXIT_CODES,
  RECOVERY_GUIDANCE,
} from "./constants.js";
import type { RuntimeMeta } from "./pin.js";

export interface InvokeOptions {
  readonly projectRoot: string;
  readonly launcherVersion: string;
  readonly runtime: RuntimeMeta;
  readonly argv: readonly string[];
  readonly stdio?: "inherit" | "pipe";
}

export interface InvokeResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly spawned: boolean;
  readonly message: string | null;
}

export function invokeRuntime(options: InvokeOptions): InvokeResult {
  const { projectRoot, launcherVersion, runtime, argv } = options;
  if (!existsSync(runtime.entryPath)) {
    return {
      exitCode: EXIT_CODES.FAILURE,
      stdout: "",
      stderr: "",
      spawned: false,
      message: `Runtime entry missing at ${runtime.entryPath}. ${RECOVERY_GUIDANCE}`,
    };
  }
  const stdio = options.stdio ?? "inherit";
  // Keep the caller's cwd so relative --project-root / file args stay relative to
  // the invocation directory. Pass the discovered root via env for the runtime.
  const result = spawnSync(process.execPath, [runtime.entryPath, ...argv], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      [ENV_PROJECT_ROOT]: projectRoot,
      [ENV_LAUNCHER_VERSION]: launcherVersion,
    },
    encoding: "utf8",
    stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    return {
      exitCode: EXIT_CODES.FAILURE,
      stdout: "",
      stderr: String(result.error),
      spawned: false,
      message: `Failed to start runtime: ${result.error.message}`,
    };
  }
  const status = result.status;
  if (status === null && result.signal) {
    return {
      exitCode: EXIT_CODES.INTERRUPTED,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      spawned: true,
      message: `Runtime interrupted (${result.signal})`,
    };
  }
  return {
    exitCode: status ?? EXIT_CODES.FAILURE,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    spawned: true,
    message: null,
  };
}

/** Build Contract 1 setup argv. */
export function setupArgv(
  operation: "install" | "repair" | "upgrade",
  from: string,
  root: string,
): string[] {
  return ["setup", "--operation", operation, "--from", from, "--root", root];
}

export function migrateArgv(from: string, root: string): string[] {
  return ["migrate", "--from", from, "--root", root];
}

export function uninstallArgv(root: string): string[] {
  return ["uninstall", "--root", root];
}

/** AC4.10 equal-version data-status probe (machine JSON only). */
export function doctorArgv(): string[] {
  return ["doctor", "--data-status"];
}

/** Human-facing full diagnosis (R12). */
export function doctorDiagnoseArgv(): string[] {
  return ["doctor"];
}
