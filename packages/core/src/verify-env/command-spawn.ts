import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { SpawnResult } from "../release/types.js";
import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";

export interface ResolveCommandOnPathOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly exists?: (path: string) => boolean;
}

/** Windows command shims (.cmd/.bat) need a shell; native executables do not. */
export function shouldUseShellForCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
}

/**
 * Quote a win32 executable path for `shell: true` spawns when it contains spaces.
 * Without quoting, cmd.exe treats `C:\Program` as the command (#2555).
 */
export function quoteWin32CommandForShell(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32" || !command.includes(" ")) {
    return command;
  }
  if (
    (command.startsWith('"') && command.endsWith('"')) ||
    (command.startsWith("'") && command.endsWith("'"))
  ) {
    return command;
  }
  return `"${command}"`;
}

/**
 * Resolve an executable on PATH with PATHEXT / Path awareness (#2467 / #2548).
 * Mirrors ts-check-lane `resolvePnpm` and verify-tools `defaultProbe`.
 */
export function resolveCommandOnPath(
  command: string,
  options: ResolveCommandOnPathOptions = {},
): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;

  const pathValue = env.PATH ?? env.Path ?? "";
  if (pathValue === "") {
    return null;
  }
  const isWindows = platform === "win32";
  const exts = isWindows ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  const sep = isWindows ? ";" : ":";
  const joinPath = isWindows ? win32.join : posix.join;
  for (const dir of pathValue.split(sep)) {
    if (dir === "") continue;
    for (const ext of exts) {
      const candidate = joinPath(dir, `${command}${ext}`);
      if (exists(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

export interface SpawnCommandTextOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

/**
 * spawnSync wrapper that applies win32 PATHEXT / shell rules (#2467 / #2548).
 * Retries with `shell: true` on win32 ENOENT (npm global `.cmd` shims).
 */
export function spawnCommandText(
  cmd: string,
  args: readonly string[],
  options: SpawnCommandTextOptions = {},
): SpawnResult {
  const trySpawn = (shell: boolean) => {
    const spawnCmd = shell && process.platform === "win32" ? quoteWin32CommandForShell(cmd) : cmd;
    return spawnSync(spawnCmd, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      encoding: "utf8",
      timeout: options.timeoutMs,
      maxBuffer: SUBPROCESS_MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
      shell,
      // CREATE_NO_WINDOW on win32; harmless elsewhere (#2563).
      windowsHide: true,
    });
  };

  let result = trySpawn(shouldUseShellForCommand(cmd));
  const spawnErr = result.error as NodeJS.ErrnoException | undefined;
  if (spawnErr?.code === "ENOENT" && process.platform === "win32") {
    result = trySpawn(true);
  }

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
