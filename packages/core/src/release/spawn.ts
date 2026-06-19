import { spawnSync } from "node:child_process";
import type { SpawnResult } from "./types.js";

export function defaultWhich(name: string): string | null {
  const result = spawnSync("which", [name], { encoding: "utf8" });
  if (result.status !== 0) {
    return null;
  }
  const path = (result.stdout ?? "").trim();
  return path || null;
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
    stdio: ["ignore", "pipe", "pipe"],
  });
  let status = result.status;
  if (status === null) {
    if (result.signal !== null && result.signal !== undefined) {
      status = 128;
    } else if (result.error) {
      status = 2;
    } else {
      status = 0;
    }
  }
  return {
    status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}
