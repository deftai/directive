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

/** #4659: next step when PowerShell-visible deft-hook is still a Restricted .ps1. */
export const POWERSHELL_RESTRICTED_CMD_RECOVERY =
  "Next step: package postinstall must remove the deft-hook.ps1 shim so Get-Command under Restricted selects deft-hook.cmd (#4654). Do not set ExecutionPolicy Bypass; reinstall alone is not enough while the .ps1 remains.";

export interface PowershellBinReachabilityResult {
  readonly ok: boolean;
  readonly skipped: boolean;
  readonly source: string | null;
  readonly detail: string;
}

export interface ProbePowershellBinReachabilityOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly spawnSyncFn?: typeof spawnSync;
}

/**
 * Under Restricted PowerShell, confirm Get-Command resolves to a non-.ps1 entry
 * and that entry runs (#4659 / #4654). Node PATHEXT probes alone can green while
 * the host still selects .ps1.
 */
export function probePowershellBinReachability(
  commandName: string,
  options: ProbePowershellBinReachabilityOptions = {},
): PowershellBinReachabilityResult {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { ok: true, skipped: true, source: null, detail: "non-windows" };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(commandName)) {
    return { ok: false, skipped: false, source: null, detail: "unsafe command name" };
  }
  const env = options.env ?? process.env;
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
  const powershellExe = win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script = [
    `$cmd = Get-Command -Name ${commandName} -ErrorAction Stop`,
    `Write-Output ('SRC|' + $cmd.Source)`,
    `& $cmd.Source --help 1>$null 2>$null`,
  ].join("; ");
  const spawn = options.spawnSyncFn ?? spawnSync;
  const result = spawn(
    powershellExe,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Restricted", "-Command", script],
    { encoding: "utf8", env, windowsHide: true, timeout: 15_000 },
  );
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const errText = result.error === undefined ? "" : result.error.message;
  const combined = `${stderr}\n${errText}\n${stdout}`;
  const srcLine = stdout.split(/\r?\n/).find((line) => line.startsWith("SRC|"));
  const source = srcLine === undefined ? null : srcLine.slice(4);
  const policy = /PSSecurityException|running scripts is disabled|UnauthorizedAccess/i.test(
    combined,
  );
  // Classify Get-Command source before process exit: deft-hook.cmd rejects --help
  // with exit 2, which must not fail after Restricted selected a non-.ps1 shim.
  if (source !== null && source.length > 0) {
    if (/\.ps1$/i.test(source)) {
      return {
        ok: false,
        skipped: false,
        source,
        detail: policy
          ? `Restricted PowerShell refused ${commandName} (likely .ps1): ${combined.trim().slice(0, 240)}`
          : `Get-Command selected .ps1 under Restricted: ${source}`,
      };
    }
    if (/\.(cmd|bat|exe|com)$/i.test(source)) {
      if (policy) {
        return {
          ok: false,
          skipped: false,
          source,
          detail: `Restricted PowerShell refused ${commandName} (likely .ps1): ${combined.trim().slice(0, 240)}`,
        };
      }
      return {
        ok: true,
        skipped: false,
        source,
        detail: `Restricted Get-Command selected ${source}`,
      };
    }
  }
  if (result.status !== 0) {
    return {
      ok: false,
      skipped: false,
      source,
      detail: policy
        ? `Restricted PowerShell refused ${commandName} (likely .ps1): ${combined.trim().slice(0, 240)}`
        : `Restricted PowerShell probe failed for ${commandName}: ${combined.trim().slice(0, 240)}`,
    };
  }
  if (source === null || source.length === 0) {
    return {
      ok: false,
      skipped: false,
      source: null,
      detail: `Get-Command ${commandName} produced no Source`,
    };
  }
  return {
    ok: false,
    skipped: false,
    source,
    detail: `Get-Command source is not a non-.ps1 executable shim: ${source}`,
  };
}
