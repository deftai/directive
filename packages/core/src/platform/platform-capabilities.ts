import { existsSync, readFileSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import {
  IDENTITY_LOCAL_USER,
  IDENTITY_REAL_ROOT,
  IDENTITY_SANDBOX_REMAPPED_LOCAL_USER,
  IDENTITY_UNKNOWN,
  RUNTIME_MODE_CLOUD_HEADLESS,
  RUNTIME_MODE_CURSOR_NATIVE_SANDBOX,
  RUNTIME_MODE_LOCAL_UNSANDBOXED,
} from "./constants.js";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

const CURSOR_SIGNAL_VARS = [
  "CURSOR_SANDBOX",
  "CURSOR_SANDBOX_LANDLOCK_STATUS",
  "CURSOR_ORIG_UID",
  "CURSOR_ORIG_GID",
  "CURSOR_AGENT",
  "CURSOR_COMPOSER",
] as const;

const CLOUD_SIGNAL_VARS = [
  "CURSOR_AGENT",
  "GROK_BUILD",
  "DEFT_AGENT_RUNTIME",
  "CI",
  "GITHUB_ACTIONS",
  "BUILDKITE",
] as const;

export interface UidMapEntry {
  readonly insideId: number;
  readonly outsideId: number;
  readonly length: number;
}

export interface OwnershipFacts {
  readonly path: string;
  readonly uid: number;
  readonly gid: number;
  readonly interpretedAsSandboxView: boolean;
}

export interface RuntimeCapabilityReport {
  readonly runtimeMode: string;
  readonly identityKind: string;
  readonly effectiveUid: number | null;
  readonly effectiveUsername: string | null;
  readonly uidMap: readonly UidMapEntry[];
  readonly cursorOrigUid: number | null;
  readonly cursorOrigGid: number | null;
  readonly sandboxUidRemap: boolean;
  readonly ownership: OwnershipFacts | null;
  readonly signals: Readonly<Record<string, string>>;
}

function envTruthy(environ: Readonly<Record<string, string>>, name: string): boolean {
  return TRUTHY.has((environ[name] ?? "").trim().toLowerCase());
}

function parseIntValue(value: string | undefined): number | null {
  if (value === undefined) return null;
  const text = value.trim();
  if (!text) return null;
  const n = Number.parseInt(text, 10);
  return Number.isNaN(n) ? null : n;
}

export function readUidMap(path: string): readonly UidMapEntry[] {
  if (!existsSync(path)) return [];
  const entries: UidMapEntry[] = [];
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts.length !== 3) continue;
    const insideId = Number.parseInt(parts[0] ?? "", 10);
    const outsideId = Number.parseInt(parts[1] ?? "", 10);
    const length = Number.parseInt(parts[2] ?? "", 10);
    if (Number.isNaN(insideId) || Number.isNaN(outsideId) || Number.isNaN(length)) continue;
    entries.push({ insideId, outsideId, length });
  }
  return entries;
}

export function detectSandboxUidRemap(
  uidMap: readonly UidMapEntry[],
  options: { effectiveUid: number | null; cursorOrigUid: number | null },
): boolean {
  if (options.effectiveUid !== 0) return false;
  if (options.cursorOrigUid === null) return false;
  return uidMap.some((entry) => entry.insideId === 0 && entry.outsideId === options.cursorOrigUid);
}

export function classifyIdentityKind(options: {
  effectiveUid: number | null;
  sandboxUidRemap: boolean;
}): string {
  if (options.effectiveUid === null) return IDENTITY_UNKNOWN;
  if (options.effectiveUid === 0) {
    return options.sandboxUidRemap ? IDENTITY_SANDBOX_REMAPPED_LOCAL_USER : IDENTITY_REAL_ROOT;
  }
  return IDENTITY_LOCAL_USER;
}

function isCloudHeadless(environ: Readonly<Record<string, string>>): boolean {
  if (envTruthy(environ, "CURSOR_AGENT")) return true;
  if (envTruthy(environ, "GROK_BUILD")) return true;
  const runtime = (environ.DEFT_AGENT_RUNTIME ?? "").trim().toLowerCase();
  if (runtime === "grok-build" || runtime === "cloud" || runtime === "headless") return true;
  if (envTruthy(environ, "GITHUB_ACTIONS") || envTruthy(environ, "BUILDKITE")) return true;
  return envTruthy(environ, "CI") && !envTruthy(environ, "CURSOR_COMPOSER");
}

function isCursorNativeSandbox(
  environ: Readonly<Record<string, string>>,
  sandboxUidRemap: boolean,
): boolean {
  if (sandboxUidRemap) return true;
  if (envTruthy(environ, "CURSOR_SANDBOX")) return true;
  return Boolean((environ.CURSOR_SANDBOX_LANDLOCK_STATUS ?? "").trim());
}

export function classifyRuntimeMode(
  environ: Readonly<Record<string, string>>,
  sandboxUidRemap: boolean,
): string {
  if (isCloudHeadless(environ)) return RUNTIME_MODE_CLOUD_HEADLESS;
  if (isCursorNativeSandbox(environ, sandboxUidRemap)) return RUNTIME_MODE_CURSOR_NATIVE_SANDBOX;
  return RUNTIME_MODE_LOCAL_UNSANDBOXED;
}

function readOwnership(path: string, sandboxUidRemap: boolean): OwnershipFacts | null {
  try {
    const stat = statSync(path);
    return {
      path,
      uid: stat.uid,
      gid: stat.gid,
      interpretedAsSandboxView: sandboxUidRemap,
    };
  } catch {
    return null;
  }
}

function collectSignals(environ: Readonly<Record<string, string>>): Record<string, string> {
  const names = [...new Set([...CURSOR_SIGNAL_VARS, ...CLOUD_SIGNAL_VARS])].sort();
  const out: Record<string, string> = {};
  for (const name of names) {
    if (name in environ) out[name] = environ[name] ?? "";
  }
  return out;
}

export interface ProbeRuntimeOptions {
  readonly environ?: Readonly<Record<string, string>>;
  readonly uidMapPath?: string;
  readonly cwd?: string;
  readonly effectiveUidOverride?: number | null;
  readonly effectiveUsername?: string | null;
  readonly getuid?: () => number;
}

export function probeRuntimeCapabilities(
  options: ProbeRuntimeOptions = {},
): RuntimeCapabilityReport {
  const env: Record<string, string> =
    options.environ === undefined
      ? ({ ...process.env } as Record<string, string>)
      : { ...options.environ };

  let effectiveUid: number | null;
  if (options.effectiveUidOverride !== undefined) {
    effectiveUid = options.effectiveUidOverride;
  } else if (options.getuid) {
    effectiveUid = options.getuid();
  } else {
    effectiveUid = null;
  }

  let effectiveUsername = options.effectiveUsername ?? env.USER ?? env.USERNAME ?? null;
  if (!effectiveUsername) {
    try {
      effectiveUsername = userInfo().username;
    } catch {
      effectiveUsername = null;
    }
  }

  const cursorOrigUid = parseIntValue(env.CURSOR_ORIG_UID);
  const cursorOrigGid = parseIntValue(env.CURSOR_ORIG_GID);

  const uidMapFile = options.uidMapPath ?? "/proc/self/uid_map";
  const uidMap = readUidMap(uidMapFile);

  const sandboxUidRemap = detectSandboxUidRemap(uidMap, { effectiveUid, cursorOrigUid });
  const identityKind = classifyIdentityKind({ effectiveUid, sandboxUidRemap });
  const runtimeMode = classifyRuntimeMode(env, sandboxUidRemap);

  const cwdPath = options.cwd ?? process.cwd();
  const ownership = readOwnership(cwdPath, sandboxUidRemap);

  return {
    runtimeMode,
    identityKind,
    effectiveUid,
    effectiveUsername,
    uidMap,
    cursorOrigUid,
    cursorOrigGid,
    sandboxUidRemap,
    ownership,
    signals: collectSignals(env),
  };
}

export function getPlatformCapabilities(
  options: ProbeRuntimeOptions = {},
): RuntimeCapabilityReport {
  return probeRuntimeCapabilities(options);
}

export function reportToDict(report: RuntimeCapabilityReport): Record<string, unknown> {
  return {
    runtime_mode: report.runtimeMode,
    identity_kind: report.identityKind,
    effective_uid: report.effectiveUid,
    effective_username: report.effectiveUsername,
    uid_map: report.uidMap.map((e) => ({
      inside_id: e.insideId,
      outside_id: e.outsideId,
      length: e.length,
    })),
    cursor_orig_uid: report.cursorOrigUid,
    cursor_orig_gid: report.cursorOrigGid,
    sandbox_uid_remap: report.sandboxUidRemap,
    ownership: report.ownership
      ? {
          path: report.ownership.path,
          uid: report.ownership.uid,
          gid: report.ownership.gid,
          interpreted_as_sandbox_view: report.ownership.interpretedAsSandboxView,
        }
      : null,
    signals: report.signals,
  };
}
