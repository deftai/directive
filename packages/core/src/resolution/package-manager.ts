/**
 * Package-manager abstraction for the resolution spine (#2197, from #2264).
 *
 * The documented install/upgrade path historically hard-coded npm
 * (`npm i -g @deftai/directive`). pnpm-managed setups have no first-class
 * flow, and mixing an npm global into a pnpm environment breaks PATH/shim/store
 * consistency. This module makes the *command rendering* package-manager aware
 * so the resolution plan and doctor emit the right form for the active manager.
 *
 * Two load-bearing facts keep this small (locked on issue #2197):
 *   1. NO additional registry. pnpm resolves from the same npm registry
 *      (`registry.npmjs.org`) by default; the published `@deftai/directive`
 *      tarball is unchanged. No renderer here ever emits a `--registry` flag.
 *   2. The internal `.deft/.cli/<platform>` sandbox vendoring STAYS on npm
 *      (its `node_modules/.bin` layout is validated by `integrity.ts` and is
 *      gitignored / package-manager-invisible). Only the global, project-local,
 *      ephemeral, and upgrade command forms vary by package manager.
 *
 * Every function here is PURE (no I/O): detection consumes an injected fact-set
 * so the whole surface is unit-testable without touching the filesystem or env.
 */

export type PackageManager = "npm" | "pnpm";

export const PACKAGE_MANAGERS: readonly PackageManager[] = ["npm", "pnpm"];

export const DEFAULT_PACKAGE_MANAGER: PackageManager = "npm";

/** Canonical published engine package name. */
export const ENGINE_PACKAGE = "@deftai/directive";

export interface DetectPackageManagerInput {
  /** Environment map (reads `DEFT_PACKAGE_MANAGER` and `npm_config_user_agent`). */
  readonly env?: NodeJS.ProcessEnv;
  /** The `packageManager` field from the project package.json (Corepack), if any. */
  readonly packageManagerField?: string | null;
  /** Whether a `pnpm-lock.yaml` is present at the project root. */
  readonly pnpmLockPresent?: boolean;
}

function normalizePackageManager(value: string): PackageManager | null {
  const v = value.trim().toLowerCase();
  if (v.startsWith("pnpm")) return "pnpm";
  if (v.startsWith("npm")) return "npm";
  return null;
}

/**
 * Detect the active package manager. Precedence (first match wins):
 *   1. `DEFT_PACKAGE_MANAGER` env override
 *   2. `packageManager` field / Corepack shim
 *   3. `pnpm-lock.yaml` present
 *   4. `npm_config_user_agent` (set by the manager that spawned the process)
 *   5. default: npm
 */
export function detectPackageManager(input: DetectPackageManagerInput = {}): PackageManager {
  const env = input.env ?? {};

  const override = env.DEFT_PACKAGE_MANAGER;
  if (typeof override === "string" && override.trim() !== "") {
    const pm = normalizePackageManager(override);
    if (pm) return pm;
  }

  if (input.packageManagerField != null && input.packageManagerField.trim() !== "") {
    const pm = normalizePackageManager(input.packageManagerField);
    if (pm) return pm;
  }

  if (input.pnpmLockPresent) return "pnpm";

  const ua = env.npm_config_user_agent;
  if (typeof ua === "string" && ua.trim() !== "") {
    const pm = normalizePackageManager(ua);
    if (pm) return pm;
  }

  return DEFAULT_PACKAGE_MANAGER;
}

/**
 * Render a global install command, e.g. `npm i -g @deftai/directive@0.65.0`
 * (npm) or `pnpm add -g @deftai/directive@0.65.0` (pnpm). `spec` is the full
 * package spec including any `@version` suffix.
 */
export function renderGlobalInstall(pm: PackageManager, spec: string = ENGINE_PACKAGE): string {
  return pm === "pnpm" ? `pnpm add -g ${spec}` : `npm i -g ${spec}`;
}

/**
 * Render a project-local (dev-dependency) install command. pnpm-managed repos
 * that prefer not to install globally use this.
 */
export function renderProjectInstall(pm: PackageManager, spec: string = ENGINE_PACKAGE): string {
  return pm === "pnpm" ? `pnpm add -D ${spec}` : `npm install --save-dev ${spec}`;
}

/**
 * Render an ephemeral (no-install) invocation, e.g. `npx @deftai/directive update`
 * (npm) or `pnpm dlx @deftai/directive update` (pnpm).
 */
export function renderEphemeral(
  pm: PackageManager,
  subcommand: string,
  pkg: string = ENGINE_PACKAGE,
): string {
  const runner = pm === "pnpm" ? "pnpm dlx" : "npx";
  const tail = subcommand.trim() === "" ? "" : ` ${subcommand.trim()}`;
  return `${runner} ${pkg}${tail}`;
}

export interface PackageManagerCommands {
  readonly packageManager: PackageManager;
  /** Global install of the engine at the given spec. */
  readonly globalInstall: string;
  /** Project-local (dev-dependency) install of the engine. */
  readonly projectInstall: string;
  /** Ephemeral `update` invocation. */
  readonly ephemeralUpdate: string;
  /** The canonical upgrade one-liner (global install of `@latest`). */
  readonly upgradeOneLiner: string;
}

/**
 * Render the full command matrix for a package manager at a given spec
 * (defaults to `@latest`). Single-sourced so docs, doctor, and the plan all
 * derive from the same renderers.
 */
export function renderPackageManagerCommands(
  pm: PackageManager,
  spec: string = `${ENGINE_PACKAGE}@latest`,
): PackageManagerCommands {
  return {
    packageManager: pm,
    globalInstall: renderGlobalInstall(pm, spec),
    projectInstall: renderProjectInstall(pm, spec),
    ephemeralUpdate: renderEphemeral(pm, "update"),
    upgradeOneLiner: renderGlobalInstall(pm, `${ENGINE_PACKAGE}@latest`),
  };
}
