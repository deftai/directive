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

export const HOST_CAPABILITY_STAMP_SCHEMA_VERSION = 1 as const;

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
  return {
    schema_version: HOST_CAPABILITY_STAMP_SCHEMA_VERSION,
    descriptor,
    primitive: rec.primitive,
    stamped_at: stampedAt,
    source,
  };
}

export function readHostCapabilityStamp(projectRoot: string): HostCapabilityStamp | null {
  const path = hostCapabilityStampPath(projectRoot);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parseHostCapabilityStamp(raw);
  } catch {
    return null;
  }
}

/**
 * Write a durable Grok Build / Tier-1 stamp. Parents SHOULD call this before
 * CLI `verify:review-monitor` / `pr:watch` subprocesses (#5229).
 */
export function writeHostCapabilityStamp(
  projectRoot: string,
  input: {
    readonly descriptor?: string;
    readonly primitive?: StampPlatformPrimitive;
    readonly source?: string;
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
  const stamp: HostCapabilityStamp = {
    schema_version: HOST_CAPABILITY_STAMP_SCHEMA_VERSION,
    descriptor: (input.descriptor ?? "grok-build").trim() || "grok-build",
    primitive: input.primitive ?? "spawn_subagent",
    stamped_at: (input.now ?? new Date()).toISOString(),
    source: (input.source ?? "host-grok-build").trim() || "host-grok-build",
  };
  if (!STAMP_PRIMITIVES.has(stamp.primitive)) {
    return { ok: false, reason: `invalid platform primitive for stamp: ${stamp.primitive}` };
  }
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
 */
export function environPatchFromHostCapabilityStamp(
  stamp: HostCapabilityStamp,
): NodeJS.ProcessEnv {
  const patch: NodeJS.ProcessEnv = {};
  if (stamp.primitive === "spawn_subagent" || stamp.descriptor === "grok-build") {
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
