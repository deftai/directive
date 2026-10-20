/**
 * Launcher-local Contract 1 constants (UNIFIED §A5.5 / R16).
 * Duplicated here so @deftai/directive has zero package dependencies (AC3.1).
 */

export const LAUNCHER_PACKAGE_NAME = "@deftai/directive";
export const RUNTIME_PACKAGE_NAME = "@deftai/directive-runtime";

/** Contract 1 integer; launcher supports 1..LAUNCHER_MAX_SUPPORTED_CONTRACT. */
export const CONTRACT_NUMBER = 1 as const;
export const LAUNCHER_MAX_SUPPORTED_CONTRACT = CONTRACT_NUMBER;

export const CONTRACT_PACKAGE_JSON_KEY = "directive" as const;

export const EXIT_CODES = {
  SUCCESS: 0,
  FAILURE: 1,
  USAGE: 2,
  INTERRUPTED: 130,
} as const;

/** engines.node floor; below this the launcher stops (AC16.3). */
export const NODE_ENGINES_FLOOR_MAJOR = 20;

/**
 * Best-effort warning threshold (AC16.4 / AC16.5).
 * Warn when major < this value (i.e. Node 20/21 today). Single constant to move later.
 */
export const NODE_SUPPORTED_MAJOR = 22;

export const NODE_EOL_NOTE =
  "Node 20 reached end of life on 30 April 2026. Directive is tested on Node 22 and 24 and runs on 20 on a best-effort basis.";

export const RECOVERY_GUIDANCE = "npm i -g @deftai/directive, then directive install --repair";

/** Env vars passed when spawning the runtime (AC4.2). */
export const ENV_PROJECT_ROOT = "DIRECTIVE_PROJECT_ROOT";
export const ENV_LAUNCHER_VERSION = "DIRECTIVE_LAUNCHER_VERSION";

export const INSTALL_MANAGEMENT_COMMANDS = ["install", "upgrade", "uninstall", "doctor"] as const;

export const INSTALL_ALIASES: Record<string, (typeof INSTALL_MANAGEMENT_COMMANDS)[number]> = {
  init: "install",
  update: "upgrade",
  remove: "uninstall",
};

/** Retired installation verbs — rejected rather than revived (AC3.16 / AC13.6). */
export const RETIRED_INSTALL_VERBS = new Set([
  "sync",
  "bootstrap",
  "migrate",
  "install-upgrade",
  "install-uninstall",
]);
