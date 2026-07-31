import { spawnSync } from "node:child_process";
import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";
import type { SpawnResult } from "./types.js";

export function defaultWhich(name: string): string | null {
  const locator = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(locator, [name], { encoding: "utf8" });
  if (result.status !== 0) {
    return null;
  }
  // `where` on Windows may return multiple lines; take the first non-empty match.
  const first = (result.stdout ?? "").split(/\r?\n/).find((line) => line.trim().length > 0);
  return first ? first.trim() : null;
}

export function spawnText(
  cmd: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {},
): SpawnResult {
  const result = spawnSync(cmd, [...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: SUBPROCESS_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let status = result.status;
  let stderr = typeof result.stderr === "string" ? result.stderr : "";
  if (status === null) {
    if (result.signal !== null && result.signal !== undefined) {
      status = 128;
      // Timeout kills leave stderr empty; surface timeout so e2e never reports
      // "failed: " with a blank reason (#3004 / #1867).
      if (stderr.trim().length === 0) {
        if (result.error) {
          stderr = result.error.message;
        } else if (options.timeoutMs !== undefined) {
          stderr = `process terminated by signal ${result.signal} (timeout ${options.timeoutMs}ms)`;
        } else {
          stderr = `process terminated by signal ${result.signal}`;
        }
      }
    } else if (result.error) {
      status = 2;
      // ENOBUFS (stdout over maxBuffer) and similar spawn failures leave stderr
      // empty; surface the error so callers never report a blank reason (#1867).
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
