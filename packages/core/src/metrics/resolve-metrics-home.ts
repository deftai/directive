/**
 * Shared metrics home resolver (#2545).
 *
 * Helped (value / CRUD) and health (eval:health) append logs are machine-local
 * telemetry — not project source. They resolve outside the git worktree via an
 * explicit ladder shared with USER.md platform discovery (#2271 / #2544):
 *
 *   1. `DEFT_METRICS_HOME` or `DEFT_EVAL_HOME` — explicit override (CI / headless)
 *   2. `<projectRoot>/.deft/metrics/` — workspace-local opt-in when
 *      `DEFT_METRICS_PROJECT_LOCAL=1`
 *   3. Platform user-data (`%APPDATA%\deft\metrics` / `~/.config/deft/metrics`)
 *   4. Soft-disable when the resolved root is not writable — never fall back to
 *      `xbrief/.eval/results/`.
 */

import { accessSync, constants, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { platformUserConfigDir } from "../user-config/resolve-user-md.js";

export const METRICS_DISABLED_DIAGNOSTIC = "metrics persistence disabled";
export const DEFT_METRICS_HOME_ENV = "DEFT_METRICS_HOME";
export const DEFT_EVAL_HOME_ENV = "DEFT_EVAL_HOME";
export const DEFT_METRICS_PROJECT_LOCAL_ENV = "DEFT_METRICS_PROJECT_LOCAL";
export const PROJECT_LOCAL_METRICS_DIR = ".deft/metrics";
export const HELPED_METRICS_FILENAME = "crud-metrics.jsonl";
export const HEALTH_METRICS_FILENAME = "health-history.jsonl";

export type MetricsHomeRung = "env-override" | "project-local" | "platform-user-data" | "disabled";

export interface ResolveMetricsHomeResult {
  /** Absolute metrics root, or null when persistence is disabled. */
  readonly root: string | null;
  readonly rung: MetricsHomeRung;
  /** False when no writable metrics root could be resolved. */
  readonly enabled: boolean;
  readonly diagnostic: string;
}

export interface ResolveMetricsHomeOptions {
  readonly projectRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  /** Writable probe. Defaults to mkdir + W_OK access check. */
  readonly probeWritable?: (path: string) => boolean;
}

function defaultProbeWritable(path: string): boolean {
  try {
    mkdirSync(path, { recursive: true });
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function metricsEnvOverride(env: NodeJS.ProcessEnv): string | null {
  const primary = env[DEFT_METRICS_HOME_ENV]?.trim();
  if (primary) {
    return primary;
  }
  const legacy = env[DEFT_EVAL_HOME_ENV]?.trim();
  return legacy || null;
}

/**
 * Resolve the platform user-data metrics directory (`%APPDATA%\deft\metrics` /
 * `~/.config/deft/metrics`).
 */
export function platformMetricsDir(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homeDir: string,
): string {
  return join(platformUserConfigDir(platform, env, homeDir), "metrics");
}

/** Resolve the metrics home root across the first-hit-wins ladder (#2545). */
export function resolveMetricsHome(
  options: ResolveMetricsHomeOptions = {},
): ResolveMetricsHomeResult {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? homedir();
  const projectRoot = options.projectRoot ?? process.cwd();
  const probeWritable = options.probeWritable ?? defaultProbeWritable;

  const override = metricsEnvOverride(env);
  if (override) {
    const root = resolve(override);
    if (probeWritable(root)) {
      return {
        root,
        rung: "env-override",
        enabled: true,
        diagnostic: `metrics home resolved from ${DEFT_METRICS_HOME_ENV}/${DEFT_EVAL_HOME_ENV}: ${root}`,
      };
    }
    return {
      root: null,
      rung: "disabled",
      enabled: false,
      diagnostic: `${METRICS_DISABLED_DIAGNOSTIC} (${DEFT_METRICS_HOME_ENV} not writable: ${root})`,
    };
  }

  if (env[DEFT_METRICS_PROJECT_LOCAL_ENV] === "1") {
    const root = resolve(join(projectRoot, PROJECT_LOCAL_METRICS_DIR));
    if (probeWritable(root)) {
      return {
        root,
        rung: "project-local",
        enabled: true,
        diagnostic: `metrics home resolved from workspace-local opt-in: ${root}`,
      };
    }
    return {
      root: null,
      rung: "disabled",
      enabled: false,
      diagnostic: `${METRICS_DISABLED_DIAGNOSTIC} (workspace-local metrics dir not writable: ${root})`,
    };
  }

  const root = platformMetricsDir(platform, env, homeDir);
  if (probeWritable(root)) {
    return {
      root,
      rung: "platform-user-data",
      enabled: true,
      diagnostic: `metrics home resolved from platform user-data: ${root}`,
    };
  }

  return {
    root: null,
    rung: "disabled",
    enabled: false,
    diagnostic: `${METRICS_DISABLED_DIAGNOSTIC} (platform user-data not writable: ${root})`,
  };
}

/** Absolute path to the helped / value metrics ledger (`helped/crud-metrics.jsonl`). */
export function helpedMetricsHistoryPath(
  projectRoot: string,
  options: ResolveMetricsHomeOptions = {},
): string | null {
  const home = resolveMetricsHome({ ...options, projectRoot });
  if (!home.enabled || home.root === null) {
    return null;
  }
  return join(home.root, "helped", HELPED_METRICS_FILENAME);
}

/** Absolute path to the health metrics ledger (`health/health-history.jsonl`). */
export function healthMetricsHistoryPath(
  projectRoot: string,
  options: ResolveMetricsHomeOptions = {},
): string | null {
  const home = resolveMetricsHome({ ...options, projectRoot });
  if (!home.enabled || home.root === null) {
    return null;
  }
  return join(home.root, "health", HEALTH_METRICS_FILENAME);
}
