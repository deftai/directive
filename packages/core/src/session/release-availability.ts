import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { locateManifest, parseInstallManifest } from "../doctor/manifest.js";
import { runningInsideDeftRepo } from "../doctor/paths.js";
import { evaluateReleaseAvailability } from "../doctor/release-availability.js";
import { containedWrite } from "../fs/contained-write.js";
import { resolveTriageCachePath } from "../triage/cache-path.js";

const THROTTLE_MS = 24 * 60 * 60 * 1000;
const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org/";
const STATE_FILE_NAME = "release-availability-state.json";
/** Display/back-compat constant; resolution flows through resolveTriageCachePath (#2869). */
export const STATE_RELATIVE_PATH = join("xbrief", ".triage-cache", STATE_FILE_NAME);

function resolveReleaseAvailabilityStatePath(projectRoot: string): string {
  return resolveTriageCachePath(projectRoot, STATE_FILE_NAME);
}

export interface ReleaseAvailabilityProbeOptions {
  readonly now?: Date;
  readonly env?: NodeJS.ProcessEnv;
  readonly readText?: (path: string) => string | null;
  readonly isFile?: (path: string) => boolean;
  readonly runNpmView?: () => { ok: boolean; version: string };
  readonly readState?: (path: string) => string | null;
  readonly writeState?: (path: string, content: string) => void;
}

interface ReleaseAvailabilityState {
  readonly latestVersion?: string;
  readonly notifiedAt?: string;
}

export interface ReleaseAvailabilityProbeResult {
  readonly lines: readonly string[];
}

function defaultReadText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function defaultNpmView(): { ok: boolean; version: string } {
  const result = spawnSync(
    "npm",
    [
      "view",
      "@deftai/directive",
      "version",
      `--registry=${PUBLIC_NPM_REGISTRY}`,
      "--ignore-scripts",
    ],
    {
      encoding: "utf8",
      timeout: 5_000,
    },
  );
  const version = (result.stdout ?? "").trim().split(/\r?\n/)[0]?.trim() ?? "";
  return { ok: result.status === 0 && version.length > 0, version };
}

function parseState(text: string | null): ReleaseAvailabilityState {
  if (text === null) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object") {
      return parsed as ReleaseAvailabilityState;
    }
  } catch {
    // A stale advisory state is never allowed to block session start.
  }
  return {};
}

function isThrottled(state: ReleaseAvailabilityState, latestVersion: string, now: Date): boolean {
  if (state.latestVersion !== latestVersion || !state.notifiedAt) return false;
  const notifiedAt = Date.parse(state.notifiedAt);
  return Number.isFinite(notifiedAt) && now.getTime() - notifiedAt < THROTTLE_MS;
}

function defaultWriteState(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmpBase = `${basename(path)}.${process.pid}.tmp`;
  const temporary = join(dir, tmpBase);
  try {
    // #2980 wave D: product write sink routes through containedWrite.
    containedWrite({
      root: resolve(dir),
      target: tmpBase,
      data: content,
      mode: "create",
    });
    renameSync(temporary, path);
  } catch (err) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

/**
 * Probe the public npm registry separately from doctor. Doctor stays offline
 * by default (#2182); mutable session start may emit this bounded advisory.
 */
export function probeSessionReleaseAvailability(
  projectRoot: string,
  options: ReleaseAvailabilityProbeOptions = {},
): ReleaseAvailabilityProbeResult {
  const env = options.env ?? process.env;
  if (env.DEFT_NO_NETWORK === "1") {
    return { lines: ["[deft release] skipped (DEFT_NO_NETWORK=1)."] };
  }
  if (runningInsideDeftRepo(projectRoot)) {
    return { lines: [] };
  }

  const readText = options.readText ?? defaultReadText;
  const isFile = options.isFile ?? existsSync;
  const manifestPath = locateManifest(projectRoot, null, isFile);
  const manifestText = manifestPath ? readText(manifestPath) : null;
  if (manifestText === null) return { lines: [] };
  const manifest = parseInstallManifest(manifestText);
  const installed = (manifest.tag ?? manifest.ref ?? "").trim();
  if (evaluateReleaseAvailability(installed, null).status === "not-applicable") {
    return { lines: [] };
  }

  const lines = [
    `[deft release] Checking ${PUBLIC_NPM_REGISTRY} for a newer published Directive release.`,
  ];
  let npmResult: { ok: boolean; version: string };
  try {
    npmResult = (options.runNpmView ?? defaultNpmView)();
  } catch {
    npmResult = { ok: false, version: "" };
  }
  const availability = evaluateReleaseAvailability(
    installed,
    npmResult.ok ? npmResult.version : null,
  );
  if (availability.status !== "available") return { lines };

  let statePath: string | null = null;
  try {
    statePath = resolveReleaseAvailabilityStatePath(projectRoot);
  } catch {
    // Symlink-escaping triage-cache path: skip throttle state; still emit advisory (#2869).
    statePath = null;
  }
  const state = parseState(
    statePath !== null ? (options.readState ?? defaultReadText)(statePath) : null,
  );
  const now = options.now ?? new Date();
  if (isThrottled(state, availability.latestVersion, now)) return { lines: [] };

  const message =
    `[deft release] Newer Directive release available: v${availability.latestVersion} ` +
    `(installed v${availability.installedVersion}). Run \`npm i -g @deftai/directive@latest\`.`;
  if (statePath !== null) {
    try {
      (options.writeState ?? defaultWriteState)(
        statePath,
        `${JSON.stringify(
          { latestVersion: availability.latestVersion, notifiedAt: now.toISOString() },
          null,
          2,
        )}\n`,
      );
    } catch {
      // The advisory remains useful if its best-effort throttle state cannot persist.
    }
  }
  return { lines: [...lines, message] };
}
