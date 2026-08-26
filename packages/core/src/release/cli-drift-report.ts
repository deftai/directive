/**
 * Local-vs-released CLI drift report after a cut (#3753).
 *
 * Report-only: never runs `npm i -g`. Never fails the release. Polls all four
 * workspace packages with `--prefer-online` so a lag-poisoned npm cache cannot
 * masquerade as a missing publish.
 */

import { spawnSync } from "node:child_process";
import { PUBLIC_NPM_REGISTRY } from "../doctor/constants.js";
import { type ActiveCliCheckResult, checkActiveCliAgainstTarget } from "../session/active-cli.js";
import { RELEASE_E2E_ENV } from "./skip-ci-incident.js";
import type { ReleaseConfig } from "./types.js";

/** Same sentinel as release-e2e `REHEARSAL_VERSION` — do not poll npm for 0.0.1. */
const REHEARSAL_VERSION = "0.0.1";

/** Workspace packages published by npm-publish.yml (sibling propagate is not atomic). */
export const WORKSPACE_PACKAGES = [
  "@deftai/directive-types",
  "@deftai/directive-core",
  "@deftai/directive-content",
  "@deftai/directive",
] as const;

export type WorkspacePackageName = (typeof WORKSPACE_PACKAGES)[number];

/** Observed sibling lag was ~7 minutes; Phase 7 wait sits under this ceiling. */
export const CLI_DRIFT_POLL_TIMEOUT_MS = 10 * 60 * 1000;
export const CLI_DRIFT_POLL_INTERVAL_MS = 30_000;
/** Pipeline completion is a single probe — Step 13 returns before npm-publish.yml is green. */
export const CLI_DRIFT_PIPELINE_POLL_TIMEOUT_MS = 0;

export type RegistryVisibility =
  | "all-visible"
  | "still-propagating"
  | "publish-incomplete"
  | "skipped";

export interface WorkspacePackageProbe {
  readonly name: WorkspacePackageName;
  readonly visible: boolean;
  readonly version: string | null;
}

export interface CliDriftReport {
  readonly releasedVersion: string;
  readonly localVersion: string | null;
  readonly localPath: string | null;
  readonly match: boolean;
  readonly shadowed: boolean;
  readonly registry: RegistryVisibility;
  readonly packages: readonly WorkspacePackageProbe[];
  readonly remediation: string;
  readonly lines: readonly string[];
}

export interface CliDriftReportSeams {
  readonly checkActiveCli?: (targetVersion: string) => ActiveCliCheckResult;
  readonly viewPackage?: (name: WorkspacePackageName, version: string) => WorkspacePackageProbe;
  readonly nowMs?: () => number;
  readonly sleepMs?: (ms: number) => void;
}

export function remediationCommand(version: string): string {
  return `npm i -g @deftai/directive@${version} --prefer-online`;
}

export function npmViewArgs(name: WorkspacePackageName, version: string): string[] {
  return [
    "view",
    `${name}@${version}`,
    "version",
    "--prefer-online",
    "--ignore-scripts",
    `--registry=${PUBLIC_NPM_REGISTRY}`,
  ];
}

export function defaultViewWorkspacePackage(
  name: WorkspacePackageName,
  version: string,
): WorkspacePackageProbe {
  try {
    const result = spawnSync("npm", npmViewArgs(name, version), {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const raw = typeof result.stdout === "string" ? result.stdout : "";
    const seen = raw.trim().split(/\r?\n/)[0]?.trim() ?? "";
    const visible = result.status === 0 && seen === version;
    return { name, visible, version: seen.length > 0 ? seen : null };
  } catch {
    return { name, visible: false, version: null };
  }
}

export function classifyRegistryVisibility(opts: {
  readonly probes: readonly WorkspacePackageProbe[];
  readonly waitExhausted: boolean;
  readonly skipped: boolean;
}): RegistryVisibility {
  if (opts.skipped) return "skipped";
  const visibleCount = opts.probes.filter((p) => p.visible).length;
  if (opts.probes.length > 0 && visibleCount === opts.probes.length) return "all-visible";
  if (visibleCount === 0 && opts.waitExhausted) return "publish-incomplete";
  return "still-propagating";
}

export function pollWorkspacePackages(
  version: string,
  opts: {
    readonly timeoutMs: number;
    readonly intervalMs?: number;
    readonly viewPackage: (name: WorkspacePackageName, version: string) => WorkspacePackageProbe;
    readonly nowMs?: () => number;
    readonly sleepMs?: (ms: number) => void;
  },
): { readonly probes: readonly WorkspacePackageProbe[]; readonly waitExhausted: boolean } {
  const now = opts.nowMs ?? Date.now;
  const sleep = opts.sleepMs ?? (() => undefined);
  const interval = opts.intervalMs ?? CLI_DRIFT_POLL_INTERVAL_MS;
  const start = now();
  let probes = WORKSPACE_PACKAGES.map((name) => opts.viewPackage(name, version));
  if (probes.every((p) => p.visible)) {
    return { probes, waitExhausted: false };
  }
  if (opts.timeoutMs <= 0) {
    return { probes, waitExhausted: false };
  }
  while (now() - start < opts.timeoutMs) {
    const remaining = opts.timeoutMs - (now() - start);
    if (remaining <= 0) break;
    sleep(Math.min(interval, remaining));
    probes = WORKSPACE_PACKAGES.map((name) => opts.viewPackage(name, version));
    if (probes.every((p) => p.visible)) {
      return { probes, waitExhausted: false };
    }
  }
  return { probes, waitExhausted: true };
}

export function shouldSkipRegistryPoll(
  config: Pick<ReleaseConfig, "dryRun" | "skipTag" | "version">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (config.dryRun || config.skipTag) return true;
  if (config.version === REHEARSAL_VERSION) return true;
  if (env[RELEASE_E2E_ENV]) return true;
  if (env.CI === "true" || env.GITHUB_ACTIONS === "true") return true;
  // Unit tests never probe the live registry; production `task release` does not set VITEST.
  if (env.VITEST) return true;
  return false;
}

function formatRegistryLine(
  registry: RegistryVisibility,
  packages: readonly WorkspacePackageProbe[],
): string {
  if (registry === "skipped") {
    return "  registry: skipped (dry-run / skip-tag / rehearsal / CI — no publish to poll)";
  }
  const visible = packages.filter((p) => p.visible).map((p) => p.name);
  const missing = packages.filter((p) => !p.visible).map((p) => p.name);
  const counts = `visible ${visible.length}/${packages.length}`;
  if (registry === "all-visible") {
    return `  registry: all-visible (${counts})`;
  }
  if (registry === "publish-incomplete") {
    return `  registry: publish-incomplete (${counts}; none of the four packages resolved after the wait)`;
  }
  const missingText = missing.length > 0 ? `; missing: ${missing.join(", ")}` : "";
  return `  registry: still-propagating (${counts}${missingText})`;
}

export function buildCliDriftReport(
  releasedVersion: string,
  opts: {
    readonly skipRegistryPoll: boolean;
    readonly pollTimeoutMs?: number;
    readonly pollIntervalMs?: number;
  } & CliDriftReportSeams = { skipRegistryPoll: false },
): CliDriftReport {
  const check = opts.checkActiveCli ?? ((target: string) => checkActiveCliAgainstTarget(target));
  const cli = check(releasedVersion);
  const localVersion = cli.active?.version ?? null;
  const localPath = cli.active?.path ?? null;
  const match = localVersion !== null && localVersion === releasedVersion && cli.ok;
  const shadowed = !cli.ok && cli.candidates.length > 0;

  let packages: readonly WorkspacePackageProbe[] = [];
  let waitExhausted = false;
  if (!opts.skipRegistryPoll) {
    const view = opts.viewPackage ?? defaultViewWorkspacePackage;
    const polled = pollWorkspacePackages(releasedVersion, {
      timeoutMs: opts.pollTimeoutMs ?? CLI_DRIFT_PIPELINE_POLL_TIMEOUT_MS,
      intervalMs: opts.pollIntervalMs,
      viewPackage: view,
      nowMs: opts.nowMs,
      sleepMs: opts.sleepMs,
    });
    packages = polled.probes;
    waitExhausted = polled.waitExhausted;
  }

  const registry = classifyRegistryVisibility({
    probes: packages,
    waitExhausted,
    skipped: opts.skipRegistryPoll,
  });
  const remediation = remediationCommand(releasedVersion);
  const localLabel =
    localVersion === null
      ? "none on PATH"
      : `${localVersion}${localPath !== null ? ` (${localPath})` : ""}`;
  const lines = [
    "CLI drift report (#3753):",
    `  released: ${releasedVersion}`,
    `  local global CLI: ${localLabel}`,
    `  match: ${match ? "yes" : "no"}`,
    ...(shadowed
      ? ["  note: PATH-shadowed install — bare deft --version is not sufficient (#3233)"]
      : []),
    formatRegistryLine(registry, packages),
    `  remediation: ${remediation}`,
    "  note: report-only — this pipeline does not run npm i -g",
  ];

  return {
    releasedVersion,
    localVersion,
    localPath,
    match,
    shadowed,
    registry,
    packages,
    remediation,
    lines,
  };
}

export function formatCliDriftReport(report: CliDriftReport): string {
  return `${report.lines.join("\n")}\n`;
}

/** Best-effort wrapper — a report failure must never fail the cut. */
export function emitCliDriftReportBestEffort(
  releasedVersion: string,
  opts: Parameters<typeof buildCliDriftReport>[1],
  write: (text: string) => void = (text) => {
    process.stderr.write(text);
  },
): void {
  try {
    write(formatCliDriftReport(buildCliDriftReport(releasedVersion, opts)));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    write(`CLI drift report (#3753): skipped (${reason.replace(/\r?\n/g, " ")})\n`);
  }
}
