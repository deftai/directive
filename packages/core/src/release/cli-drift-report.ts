/**
 * Local-vs-released CLI drift report after a cut (#3753).
 *
 * Report-only: never runs `npm i -g`. Never fails the release. Polls all four
 * workspace packages with `--prefer-online` so a lag-poisoned npm cache cannot
 * masquerade as a missing publish.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PUBLIC_NPM_REGISTRY } from "../doctor/constants.js";
import { containedWrite } from "../fs/contained-write.js";
import { type ActiveCliCheckResult, checkActiveCliAgainstTarget } from "../session/active-cli.js";
import { EXIT_CONFIG_ERROR, EXIT_OK } from "./constants.js";
import { RELEASE_E2E_ENV } from "./skip-ci-incident.js";
import type { ReleaseConfig } from "./types.js";
import { validateVersion } from "./version.js";

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
  | "probe-failed"
  | "skipped";

export interface WorkspacePackageProbe {
  readonly name: WorkspacePackageName;
  readonly visible: boolean;
  readonly version: string | null;
  readonly probeFailed?: boolean;
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

/** Membership in `npm view <pkg> versions` — the v0.113.0 / v0.116.0 miss. */
export function npmViewArgs(name: WorkspacePackageName, _version: string): string[] {
  return ["view", name, "versions", "--json", "--prefer-online", "--ignore-scripts"];
}

export function versionsListContains(stdout: string, version: string): boolean {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "string") return parsed === version;
    if (Array.isArray(parsed)) return parsed.map(String).includes(version);
    if (parsed !== null && typeof parsed === "object" && "versions" in parsed) {
      const versions = (parsed as { versions?: unknown }).versions;
      if (Array.isArray(versions)) return versions.map(String).includes(version);
    }
  } catch {
    /* fall through */
  }
  return trimmed.split(/\r?\n/).some((line) => line.trim() === version);
}

/** Synchronous non-spinning sleep. Production default for the Phase 7 wait (#4267). */
export function defaultCliDriftSleepMs(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function defaultViewWorkspacePackage(
  name: WorkspacePackageName,
  version: string,
): WorkspacePackageProbe {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), "deft-cli-drift-npm-view-"));
    containedWrite({
      root: dir,
      target: ".npmrc",
      data: `@deftai:registry=${PUBLIC_NPM_REGISTRY}\nregistry=${PUBLIC_NPM_REGISTRY}\n`,
      mode: "create",
    });
    const result = spawnSync("npm", npmViewArgs(name, version), {
      cwd: dir,
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const raw = typeof result.stdout === "string" ? result.stdout : "";
    if (result.error !== undefined || result.status !== 0) {
      return { name, visible: false, version: null, probeFailed: true };
    }
    const visible = versionsListContains(raw, version);
    return { name, visible, version: visible ? version : null, probeFailed: false };
  } catch {
    return { name, visible: false, version: null, probeFailed: true };
  } finally {
    if (dir !== undefined) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }
  }
}

export function classifyRegistryVisibility(opts: {
  readonly probes: readonly WorkspacePackageProbe[];
  readonly waitExhausted: boolean;
  readonly skipped: boolean;
}): RegistryVisibility {
  if (opts.skipped) return "skipped";
  if (opts.probes.some((p) => p.probeFailed === true)) return "probe-failed";
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
  const sleep = opts.sleepMs ?? defaultCliDriftSleepMs;
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
    if (remaining < 1_000) break;
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
  if (registry === "probe-failed") {
    return `  registry: probe-failed (${counts}; npm view errors — not a missing-publish verdict; wait and retry)`;
  }
  if (registry === "publish-incomplete") {
    return `  registry: publish-incomplete (${counts}; none of the four packages resolved after the wait; wait before installing)`;
  }
  const missingText = missing.length > 0 ? `; missing: ${missing.join(", ")}` : "";
  return `  registry: still-propagating (${counts}${missingText}; wait before installing)`;
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

/** Phase 7 production caller (#4267). Uses the 10-minute ceiling and a real sleep. Report-only. */
export function phase7CliDriftPollTimeoutMs(): number {
  return CLI_DRIFT_POLL_TIMEOUT_MS;
}

export function runPhase7NpmWait(
  releasedVersion: string,
  opts: {
    readonly skipRegistryPoll?: boolean;
    readonly env?: NodeJS.ProcessEnv;
  } & CliDriftReportSeams = {},
  write: (text: string) => void = (text) => {
    process.stderr.write(text);
  },
): number {
  const skip =
    opts.skipRegistryPoll ??
    shouldSkipRegistryPoll(
      { dryRun: false, skipTag: false, version: releasedVersion },
      opts.env ?? process.env,
    );
  emitCliDriftReportBestEffort(
    releasedVersion,
    {
      skipRegistryPoll: skip,
      pollTimeoutMs: CLI_DRIFT_POLL_TIMEOUT_MS,
      checkActiveCli: opts.checkActiveCli,
      viewPackage: opts.viewPackage,
      nowMs: opts.nowMs,
      sleepMs: opts.sleepMs ?? defaultCliDriftSleepMs,
    },
    write,
  );
  return EXIT_OK;
}

const PHASE7_WAIT_HELP =
  "usage: deft release-wait-npm <version>\n" +
  "  Phase 7 registry wait (#4267). Polls all four @deftai/directive* packages\n" +
  "  until each lists <version>, or 10 minutes. Report-only: never runs npm i -g,\n" +
  "  never fails the GitHub release. Step 13 of task release stays a single probe.\n";

export function cmdReleaseWaitNpm(args: readonly string[]): number {
  const unknown: string[] = [];
  let help = false;
  let version: string | null = null;
  for (const token of args) {
    if (token === "-h" || token === "--help") {
      help = true;
    } else if (token.startsWith("-")) {
      unknown.push(token);
    } else if (version === null) {
      version = token.startsWith("v") ? token.slice(1) : token;
    } else {
      unknown.push(token);
    }
  }
  if (help) {
    process.stdout.write(PHASE7_WAIT_HELP);
    return EXIT_OK;
  }
  if (unknown.length > 0) {
    process.stderr.write(`release-wait-npm: error: unrecognized arguments: ${unknown.join(" ")}\n`);
    return EXIT_CONFIG_ERROR;
  }
  if (version === null) {
    process.stderr.write(
      "release-wait-npm: error: the following arguments are required: version\n",
    );
    return EXIT_CONFIG_ERROR;
  }
  try {
    validateVersion(version);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    return EXIT_CONFIG_ERROR;
  }
  return runPhase7NpmWait(version);
}
