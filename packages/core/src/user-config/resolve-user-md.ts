/**
 * Shared USER.md resolver (#2271).
 *
 * Resolves the USER.md user-config file across an explicit first-hit-wins
 * search order so session-start, the CLI bootstrap, and doctor all share a
 * single source of truth for "where does USER.md live?" — and so it resolves
 * automatically in mismatched / headless sandboxes where `$HOME` is not a
 * persistent mount (the #2124 Cowork gap) with zero manual `DEFT_USER_PATH`.
 *
 * Search order (first hit wins):
 *   1. `DEFT_USER_PATH` — explicit override, highest precedence, points at the
 *      USER.md file directly. Always wins as the resolved path whether or not
 *      the file exists yet (presence is reported separately via `found`).
 *   2. Workspace-local bridged config (`<projectRoot>/.deft/USER.md`) — a
 *      persistent location inside the workspace that survives a non-persistent
 *      `$HOME`.
 *   3. Bridged platform config dir (`%APPDATA%\deft\USER.md` on Windows,
 *      `~/.config/deft/USER.md` elsewhere) — the historical default location.
 *   4. Sensible default (the rung-3 path) + a `no USER.md found; using
 *      defaults` diagnostic. This branch NEVER throws.
 */

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Exact diagnostic phrase emitted when USER.md is absent on every rung. */
export const NO_USER_MD_DIAGNOSTIC = "no USER.md found; using defaults";

/** The USER.md filename joined onto every candidate config directory. */
export const USER_MD_FILENAME = "USER.md";

/**
 * Workspace-local config directory (relative to the project root). This is the
 * bridged, persistent location inside the workspace that keeps preferences
 * reachable even when the platform config dir under `$HOME` is not mounted.
 */
export const WORKSPACE_LOCAL_CONFIG_DIR = ".deft";

/** Which search rung produced the resolved path. */
export type UserMdRung = "env-override" | "workspace-local" | "platform-config" | "default";

export interface ResolveUserMdResult {
  /**
   * The resolved USER.md path. For rungs 2-3 this is always an existing file.
   * For rung 1 (`env-override`) it is the override path whether or not the file
   * exists yet (check `found`). For the `default` rung it is the sensible
   * default location (which does not exist).
   */
  readonly path: string;
  /** Which search rung matched. */
  readonly rung: UserMdRung;
  /** True when a USER.md file actually exists at `path`. */
  readonly found: boolean;
  /** One-line human-readable diagnostic describing the resolution boundary. */
  readonly diagnostic: string;
  /** Candidate paths inspected, in search order (for diagnostics / tests). */
  readonly searched: readonly string[];
}

export interface ResolveUserMdOptions {
  /** Workspace root for the workspace-local rung. Defaults to `process.cwd()`. */
  readonly projectRoot?: string;
  /** Environment source (reads `DEFT_USER_PATH` / `APPDATA`). Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Platform id for the platform-config rung. Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Home directory for the platform-config rung. Defaults to `os.homedir()`. */
  readonly homeDir?: string;
  /** File-existence probe. Defaults to an `existsSync` + `isFile` check. */
  readonly fileExists?: (path: string) => boolean;
}

function defaultFileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    // Any stat error (ENOENT, permission, ...) means "not a resolvable USER.md
    // file". Deliberately NOT falling back to existsSync, which cannot tell a
    // directory from a file and would report a dir at this path as a found file.
    return false;
  }
}

/**
 * Resolve the platform config directory (`%APPDATA%\deft` / `~/.config/deft`).
 * Mirrors `init-deposit`'s `userConfigDir()` platform branch but takes the
 * platform / env / home as injectable inputs and deliberately does NOT honor
 * `DEFT_USER_PATH` — that override is rung 1, handled by the caller.
 */
export function platformUserConfigDir(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homeDir: string,
): string {
  if (platform === "win32") {
    const appData = env.APPDATA?.trim();
    return appData ? join(appData, "deft") : join(homeDir, "AppData", "Roaming", "deft");
  }
  return join(homeDir, ".config", "deft");
}

/**
 * Resolve the USER.md path across the first-hit-wins search order. Never
 * throws: an absent USER.md degrades to the sensible default location with a
 * clear `no USER.md found; using defaults` diagnostic.
 */
export function resolveUserMdPath(options: ResolveUserMdOptions = {}): ResolveUserMdResult {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? homedir();
  const projectRoot = options.projectRoot ?? process.cwd();
  const fileExists = options.fileExists ?? defaultFileExists;

  const searched: string[] = [];

  // Rung 1: DEFT_USER_PATH override (full file path); always wins.
  const override = env.DEFT_USER_PATH?.trim();
  if (override) {
    const overridePath = resolve(override);
    searched.push(overridePath);
    const found = fileExists(overridePath);
    return {
      path: overridePath,
      rung: "env-override",
      found,
      diagnostic: found
        ? `USER.md resolved from DEFT_USER_PATH: ${overridePath}`
        : `USER.md path from DEFT_USER_PATH does not exist yet: ${overridePath}`,
      searched,
    };
  }

  // Rung 2: workspace-local bridged config.
  const workspacePath = resolve(join(projectRoot, WORKSPACE_LOCAL_CONFIG_DIR, USER_MD_FILENAME));
  searched.push(workspacePath);
  if (fileExists(workspacePath)) {
    return {
      path: workspacePath,
      rung: "workspace-local",
      found: true,
      diagnostic: `USER.md resolved from workspace-local config: ${workspacePath}`,
      searched,
    };
  }

  // Rung 3: bridged platform config dir.
  const platformPath = join(platformUserConfigDir(platform, env, homeDir), USER_MD_FILENAME);
  searched.push(platformPath);
  if (fileExists(platformPath)) {
    return {
      path: platformPath,
      rung: "platform-config",
      found: true,
      diagnostic: `USER.md resolved from platform config dir: ${platformPath}`,
      searched,
    };
  }

  // Rung 4: sensible default + diagnostic (never throws).
  return {
    path: platformPath,
    rung: "default",
    found: false,
    diagnostic: `${NO_USER_MD_DIAGNOSTIC} (searched: ${searched.join(", ")})`,
    searched,
  };
}
