import {
  execFileSync,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
  spawnSync,
} from "node:child_process";
import { win32 as win32Path } from "node:path";
import { BINARY_PREFERENCE } from "./constants.js";
import { ScmStubError } from "./errors.js";

export type WhichFn = (name: string) => string | null;

/**
 * Pick a spawnable win32 hit from `where` output (#5081).
 * Prefer `.exe`/`.cmd`/`.bat` in the first match's directory so an
 * extensionless unix shim (`gh`) does not beat sibling `gh.cmd`.
 */
export function preferWin32WhichHit(
  candidates: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string | null {
  const lines = candidates.map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }
  const first = lines[0];
  if (first === undefined) {
    return null;
  }
  if (platform !== "win32") {
    return first;
  }
  const firstDir = win32Path.dirname(first);
  const sameDir = lines.filter((line) => win32Path.dirname(line) === firstDir);
  const withExt = sameDir.find((line) => /\.(?:exe|cmd|bat)$/i.test(line));
  return withExt ?? first;
}

/** Default PATH lookup mirroring Python `shutil.which`. Uses the
 * platform-native resolver (`where` on Windows, `which` elsewhere) so
 * executable resolution works cross-platform.
 * Optional `env` lets callers resolve against a child PATH (#5081 Greptile). */
export function defaultWhich(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const locator = process.platform === "win32" ? "where" : "which";
  try {
    const result = execFileSync(locator, [name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env,
    });
    // `where` may return multiple lines; prefer a PATHEXT hit in the first dir (#5081).
    return preferWin32WhichHit(result.split(/\r?\n/));
  } catch {
    return null;
  }
}

/**
 * Win32 `.cmd` / `.bat` shims need a cmd.exe /c line; native `.exe` does not.
 * Without that, `spawnSync(gh.cmd, …)` returns EINVAL (status null → exit 1)
 * and deep SCM `/user` validation fails (#5081).
 */
export function scmSpawnNeedsShell(
  command: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
}

/** Quote spaced win32 paths so cmd.exe does not split on `Program Files`. */
export function quoteWin32CommandForShell(command: string): string {
  if (!command.includes(" ")) {
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
 * Escape one argv token for cmd.exe /c so metacharacters cannot open a
 * second command (#5081 Greptile P1: unescaped `&` in labels).
 */
export function escapeWin32CmdArg(arg: string): string {
  if (arg.length === 0) {
    return '""';
  }
  if (!/[\s"&<>|^%!()]/.test(arg)) {
    return arg;
  }
  return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * Build a single cmd.exe /c command line for a `.cmd`/`.bat` binary + args.
 */
export function buildWin32CmdLine(command: string, args: readonly string[]): string {
  return [quoteWin32CommandForShell(command), ...args.map(escapeWin32CmdArg)].join(" ");
}

/**
 * spawnSync wrapper for SCM binaries: applies win32 `.cmd`/`.bat` via
 * `cmd.exe /d /s /c` with escaped args (#5081). Bare names on win32 are
 * re-resolved via `defaultWhich` against `options.env` PATH so a
 * PATH-prepended `gh.cmd` wins over a later host `gh.exe`.
 */
export function spawnScmBinary(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions = {},
): SpawnSyncReturns<string | Buffer> {
  const environ =
    options.env !== undefined
      ? (options.env as NodeJS.ProcessEnv)
      : process.env;
  let resolved = command;
  if (
    process.platform === "win32" &&
    !/[\\/]/.test(command) &&
    !/\.(?:exe|cmd|bat|com)$/i.test(command)
  ) {
    const fromPath = defaultWhich(command, environ);
    if (fromPath !== null) {
      resolved = fromPath;
    }
  }
  if (scmSpawnNeedsShell(resolved)) {
    const comspec = environ.ComSpec ?? process.env.ComSpec ?? "cmd.exe";
    return spawnSync(comspec, ["/d", "/s", "/c", buildWin32CmdLine(resolved, args)], {
      ...options,
      env: environ,
      shell: false,
      windowsHide: options.windowsHide ?? true,
    });
  }
  return spawnSync(resolved, [...args], {
    ...options,
    env: environ,
    windowsHide: options.windowsHide ?? true,
  });
}

/**
 * Return `"ghx"` if on PATH, else `"gh"`; raise if neither is present.
 * Mirrors `scripts/scm.py::resolve_binary`.
 *
 * On failure the message is the #2275 fail-loud diagnostic (execution-env
 * boundary + remediation), not an opaque spawn error.
 */
export function resolveBinary(whichFn: WhichFn = defaultWhich): string {
  for (const candidate of BINARY_PREFERENCE) {
    if (whichFn(candidate) !== null) {
      return candidate;
    }
  }
  // Keep the historical substring for existing tests / triage mappers, then
  // append the #2275 execution-env remediation so agents see a named reason.
  throw new ScmStubError(
    "neither 'ghx' nor 'gh' found on PATH in this execution env; " +
      "install GitHub CLI (https://cli.github.com/) or the ghx proxy (#884), " +
      "or pass GH_TOKEN into a matched env and re-run; SCM-dependent gates " +
      "(triage:queue, issue:ingest, pr:*, reconcile:issues, cache:fetch-all, scm:*) " +
      "cannot run here. Framework-local gates do not need SCM. Refs #2275.",
  );
}
