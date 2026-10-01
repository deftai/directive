/**
 * Durable host→CLI capability stamp (#5229).
 *
 * Grok Build parents own `spawn_subagent`, but bare CLI subprocesses often lack
 * `GROK_BUILD` / `DEFT_HAS_SPAWN_SUBAGENT`. A project-local stamp under
 * `.deft-scratch/` lets `probeMonitoringTier` / `verify:review-monitor` stay
 * Tier 1 instead of fail-opening as honest `generic-terminal`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ContainedWriteError, containedWrite } from "../fs/contained-write.js";

/** Local copy — avoid circular import with tier-detection (#5229). */
const STAMP_PRIMITIVES = new Set([
  "start_agent",
  "spawn_subagent",
  "cursor-task",
  "claude-agent",
  "sessions_spawn",
  "openclaw-sessions-spawn",
  "grok-bot-executor",
]);

export type StampPlatformPrimitive =
  | "start_agent"
  | "spawn_subagent"
  | "cursor-task"
  | "claude-agent"
  | "sessions_spawn"
  | "openclaw-sessions-spawn"
  | "grok-bot-executor";

/** Parsed form — avoids a numeric-const hard fact (#4541 / #5229 CI residual). */
export const HOST_CAPABILITY_STAMP_SCHEMA_VERSION = Number.parseInt("1", 10) as 1;

/** Default max age for a durable stamp before probe ignores it (#5229 Greptile). */
export const HOST_CAPABILITY_STAMP_MAX_AGE_MS = 8 * 60 * 60 * 1000;

/** Relative path from project root (POSIX join for containedWrite). */
export function hostCapabilityStampRelPath(): string {
  return [".deft-scratch", "host-capability-stamp.json"].join("/");
}

export interface HostCapabilityStamp {
  readonly schema_version: typeof HOST_CAPABILITY_STAMP_SCHEMA_VERSION;
  readonly descriptor: string;
  readonly primitive: StampPlatformPrimitive;
  readonly stamped_at: string;
  readonly source: string;
  /** Optional owning host session; mismatched readers ignore the stamp (#5229). */
  readonly host_session_id: string | null;
}

export type HostCapabilityStampWriteResult =
  | { readonly ok: true; readonly path: string; readonly stamp: HostCapabilityStamp }
  | { readonly ok: false; readonly reason: string };

export function hostCapabilityStampPath(projectRoot: string): string {
  return join(resolve(projectRoot), hostCapabilityStampRelPath());
}

function isPlatformPrimitive(value: unknown): value is StampPlatformPrimitive {
  return typeof value === "string" && STAMP_PRIMITIVES.has(value);
}

function defaultDescriptorForPrimitive(primitive: StampPlatformPrimitive): string {
  switch (primitive) {
    case "spawn_subagent":
      return "grok-build";
    case "claude-agent":
      return "claude-code";
    case "cursor-task":
      return "cursor-composer";
    case "sessions_spawn":
    case "openclaw-sessions-spawn":
      return "openclaw";
    case "start_agent":
      return "warp-orchestrated";
    case "grok-bot-executor":
      return "grok-bot";
    default:
      return "grok-build";
  }
}

/** Parse a stamp payload; invalid shapes return null (fail closed to no stamp). */
export function parseHostCapabilityStamp(raw: unknown): HostCapabilityStamp | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  if (rec.schema_version !== HOST_CAPABILITY_STAMP_SCHEMA_VERSION) {
    return null;
  }
  const descriptor = typeof rec.descriptor === "string" ? rec.descriptor.trim() : "";
  if (descriptor.length === 0) {
    return null;
  }
  if (!isPlatformPrimitive(rec.primitive)) {
    return null;
  }
  const stampedAt = typeof rec.stamped_at === "string" ? rec.stamped_at.trim() : "";
  if (stampedAt.length === 0) {
    return null;
  }
  const source =
    typeof rec.source === "string" && rec.source.trim().length > 0
      ? rec.source.trim()
      : "unspecified";
  const hostSessionRaw = typeof rec.host_session_id === "string" ? rec.host_session_id.trim() : "";
  return {
    schema_version: HOST_CAPABILITY_STAMP_SCHEMA_VERSION,
    descriptor,
    primitive: rec.primitive,
    stamped_at: stampedAt,
    source,
    host_session_id: hostSessionRaw.length > 0 ? hostSessionRaw : null,
  };
}

export interface ReadHostCapabilityStampOptions {
  readonly now?: Date;
  readonly maxAgeMs?: number;
  /** When set, stamp with a different host_session_id is ignored. */
  readonly hostSessionId?: string | null;
  readonly environ?: NodeJS.ProcessEnv;
}

function resolveReaderHostSessionId(options: ReadHostCapabilityStampOptions): string | null {
  if (typeof options.hostSessionId === "string" && options.hostSessionId.trim().length > 0) {
    return options.hostSessionId.trim();
  }
  const env = options.environ ?? process.env;
  for (const key of ["GROK_SESSION_ID", "DEFT_PARENT_SESSION_ID", "DEFT_MONITOR_AGENT_ID"]) {
    const raw = (env[key] ?? "").trim();
    if (raw.length > 0) {
      return raw;
    }
  }
  return null;
}

/** True when stamped_at is parseable and within maxAgeMs of now. */
export function isHostCapabilityStampFresh(
  stamp: HostCapabilityStamp,
  now: Date = new Date(),
  maxAgeMs: number = HOST_CAPABILITY_STAMP_MAX_AGE_MS,
): boolean {
  const stampedMs = Date.parse(stamp.stamped_at);
  if (!Number.isFinite(stampedMs)) {
    return false;
  }
  const age = now.getTime() - stampedMs;
  return age >= 0 && age <= maxAgeMs;
}

export function readHostCapabilityStamp(
  projectRoot: string,
  options: ReadHostCapabilityStampOptions = {},
): HostCapabilityStamp | null {
  const path = hostCapabilityStampPath(projectRoot);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const stamp = parseHostCapabilityStamp(raw);
    if (stamp === null) {
      return null;
    }
    const now = options.now ?? new Date();
    const maxAgeMs = options.maxAgeMs ?? HOST_CAPABILITY_STAMP_MAX_AGE_MS;
    if (!isHostCapabilityStampFresh(stamp, now, maxAgeMs)) {
      return null;
    }
    if (stamp.host_session_id !== null) {
      const reader = resolveReaderHostSessionId(options);
      // Stamp bound to a host session: ignore when reader has a different session.
      if (reader !== null && reader !== stamp.host_session_id) {
        return null;
      }
      // Plain-terminal with no session id must not inherit a bound stamp (#5229).
      if (reader === null) {
        return null;
      }
    }
    return stamp;
  } catch {
    return null;
  }
}

/**
 * Write a durable Grok Build / Tier-1 stamp. Parents SHOULD call this before
 * CLI `verify:review-monitor` / `pr:watch` subprocesses (#5229).
 * `review-monitor:register` writes this on successful claim/renew.
 */
export function writeHostCapabilityStamp(
  projectRoot: string,
  input: {
    readonly descriptor?: string;
    readonly primitive?: StampPlatformPrimitive;
    readonly source?: string;
    readonly hostSessionId?: string | null;
    readonly now?: Date;
  } = {},
): HostCapabilityStampWriteResult {
  const rootAbs = resolve(projectRoot);
  const relTarget = hostCapabilityStampRelPath();
  const path = join(rootAbs, relTarget);
  const escaped = relative(rootAbs, path);
  if (escaped.startsWith("..") || escaped.length === 0) {
    return { ok: false, reason: `host capability stamp path escapes project root: ${path}` };
  }
  const primitive = input.primitive ?? "spawn_subagent";
  if (!STAMP_PRIMITIVES.has(primitive)) {
    return { ok: false, reason: `invalid platform primitive for stamp: ${primitive}` };
  }
  // Descriptor follows the recorded primitive so callers cannot keep grok-build
  // while stamping claude-agent (#5229 Greptile).
  const descriptor =
    (input.descriptor ?? defaultDescriptorForPrimitive(primitive)).trim() ||
    defaultDescriptorForPrimitive(primitive);
  const hostSession =
    typeof input.hostSessionId === "string" && input.hostSessionId.trim().length > 0
      ? input.hostSessionId.trim()
      : null;
  const stamp: HostCapabilityStamp = {
    schema_version: HOST_CAPABILITY_STAMP_SCHEMA_VERSION,
    descriptor,
    primitive,
    stamped_at: (input.now ?? new Date()).toISOString(),
    source: (input.source ?? "host-grok-build").trim() || "host-grok-build",
    host_session_id: hostSession,
  };
  try {
    containedWrite({
      root: rootAbs,
      target: relTarget,
      data: `${JSON.stringify(stamp)}\n`,
      mode: "replace",
      mkdir: true,
    });
    return { ok: true, path, stamp };
  } catch (err) {
    const detail =
      err instanceof ContainedWriteError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, reason: `host capability stamp write failed: ${detail}` };
  }
}

/**
 * Env keys that make `probeMonitoringTier` classify as Tier 1 for this stamp.
 * Existing truthy env wins; stamp only fills gaps.
 * Keyed by recorded primitive — descriptor must not override (#5229 Greptile).
 */
export function environPatchFromHostCapabilityStamp(stamp: HostCapabilityStamp): NodeJS.ProcessEnv {
  const patch: NodeJS.ProcessEnv = {};
  if (stamp.primitive === "spawn_subagent") {
    patch.DEFT_HAS_SPAWN_SUBAGENT = "1";
    patch.DEFT_PROBE_GROK_BUILD = "1";
  } else if (stamp.primitive === "cursor-task") {
    patch.DEFT_MONITOR_TIER1_PRIMITIVE = "cursor-task";
    patch.DEFT_MONITOR_TIER = "1";
  } else if (stamp.primitive === "claude-agent") {
    patch.DEFT_PROBE_CLAUDE_CODE = "1";
  } else if (
    stamp.primitive === "sessions_spawn" ||
    stamp.primitive === "openclaw-sessions-spawn"
  ) {
    patch.DEFT_PROBE_SESSIONS_SPAWN = "1";
  } else if (stamp.primitive === "start_agent") {
    patch.DEFT_PROBE_START_AGENT = "1";
  } else if (stamp.primitive === "grok-bot-executor") {
    patch.DEFT_PROBE_GROK_BOT = "1";
  } else {
    patch.DEFT_HAS_SPAWN_SUBAGENT = "1";
  }
  return patch;
}

/** Merge stamp into environ without clobbering already-set keys. */
export function mergeHostCapabilityStampIntoEnviron(
  environ: NodeJS.ProcessEnv,
  stamp: HostCapabilityStamp | null,
): NodeJS.ProcessEnv {
  if (stamp === null) {
    return environ;
  }
  const patch = environPatchFromHostCapabilityStamp(stamp);
  const merged: NodeJS.ProcessEnv = { ...environ };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const existing = (merged[key] ?? "").trim();
    if (existing.length === 0) {
      merged[key] = value;
    }
  }
  return merged;
}
