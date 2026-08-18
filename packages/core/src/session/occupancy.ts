/**
 * Worktree occupancy lease (#3433).
 *
 * Ritual-state is "this session completed ceremony." Occupancy is "who may
 * mutate this tree right now." Those lifetimes differ; do not overload
 * ritual-state.json. Join negotiation (`occupancy:request`) is out of scope.
 *
 * Concurrency model:
 * - Assumptions: local filesystem; cooperating processes on one machine.
 * - Guarantees: mutual exclusion under crash-free operation; detect-and-abort
 *   if the sidecar lock is compromised (fence before rename/unlink).
 * - Non-goals: network filesystems; Byzantine processes; perfect off-Linux
 *   PID-reuse detection (hard age cap + fence instead).
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { containedRemove, containedWrite } from "../fs/contained-write.js";
import { assertWriteTargetSafe } from "../fs/projection-containment.js";
import { assertAppendLockOwned, type LockDeps, withAppendLock } from "../slice/lock.js";
import { stableJson } from "./json.js";
import { parseTimestamp, timestampIso } from "./time.js";

export const OCCUPANCY_SCHEMA_VERSION = 1;
export const OCCUPANCY_RELPATH = [".deft", "occupancy.json"] as const;
/** Crash recovery TTL: 20 minutes without heartbeat (15–30 window). */
export const OCCUPANCY_TTL_MS = 20 * 60 * 1000;
export const OCCUPANCY_INTENTS = ["mutation", "swarm", "review"] as const;
export type OccupancyIntent = (typeof OCCUPANCY_INTENTS)[number];
export const OCCUPANCY_JOIN_PROTOCOLS = ["none", "heartbeat-file", "parent-message"] as const;
export type OccupancyJoinProtocol = (typeof OCCUPANCY_JOIN_PROTOCOLS)[number];

export interface OccupancyRecord {
  readonly schemaVersion: number;
  readonly sessionId: string;
  readonly worktreePath: string;
  readonly intent: OccupancyIntent;
  readonly claimedAt: Date;
  readonly heartbeatAt: Date;
  readonly host: string;
  readonly address: string;
  readonly retainCapable: boolean;
  readonly joinProtocol: OccupancyJoinProtocol;
  readonly raw: Record<string, unknown>;
}

export type OccupancyAction = "claimed" | "heartbeat" | "stolen" | "denied" | "released";

export interface OccupancyDecision {
  readonly action: OccupancyAction;
  readonly sessionId: string;
  readonly record: OccupancyRecord | null;
  readonly path: string;
  readonly message: string;
  readonly code: number;
}

export interface ApplyOccupancyInput {
  readonly sessionId?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: Date;
  readonly intent?: OccupancyIntent;
  readonly newSessionId?: () => string;
  readonly steal?: boolean;
  readonly confirm?: boolean;
  readonly occupant?: string;
  readonly host?: string;
  readonly address?: string;
  readonly retainCapable?: boolean;
  readonly joinProtocol?: OccupancyJoinProtocol;
  /** When false, evaluate only (no write). Steal still writes. */
  readonly write?: boolean;
  /** Test seam for lock wait / timeout. */
  readonly lockDeps?: LockDeps;
}

export function occupancyPath(projectRoot: string): string {
  return join(resolve(projectRoot), ...OCCUPANCY_RELPATH);
}

export function heartbeatAgeSeconds(record: OccupancyRecord, now: Date = new Date()): number {
  return Math.max(0, Math.round((now.getTime() - record.heartbeatAt.getTime()) / 1000));
}

export function isOccupancyExpired(
  record: OccupancyRecord,
  now: Date = new Date(),
  ttlMs: number = OCCUPANCY_TTL_MS,
): boolean {
  return now.getTime() - record.heartbeatAt.getTime() > ttlMs;
}

export function formatOccupancyRemediation(
  record: OccupancyRecord,
  now: Date = new Date(),
): string {
  const age = heartbeatAgeSeconds(record, now);
  return (
    `Worktree occupied by session ${record.sessionId} (intent=${record.intent}, heartbeat ${age}s ago).\n` +
    "Stay read-only (`session:start --read-only`), use another worktree,\n" +
    "queue a join (`occupancy:request`), or steal (`occupancy:steal --confirm`)."
  );
}

export function resolveOccupancySessionId(input: ApplyOccupancyInput = {}): string {
  const explicit = input.sessionId?.trim();
  if (explicit) return explicit;
  const envId = (input.env ?? process.env).DEFT_SESSION_ID?.trim();
  if (envId) return envId;
  return (input.newSessionId ?? randomUUID)();
}

export function readOccupancy(projectRoot: string): OccupancyRecord | null {
  const path = occupancyPath(projectRoot);
  try {
    if (!existsSync(path)) return null;
  } catch {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(path, { encoding: "utf8" }));
  } catch {
    return null;
  }
  return parseOccupancy(payload, resolve(projectRoot));
}

export function liveOccupant(
  projectRoot: string,
  now: Date = new Date(),
  ttlMs: number = OCCUPANCY_TTL_MS,
): OccupancyRecord | null {
  const record = readOccupancy(projectRoot);
  if (record === null || isOccupancyExpired(record, now, ttlMs)) return null;
  return record;
}

export function applyWorktreeOccupancy(
  projectRoot: string,
  input: ApplyOccupancyInput = {},
): OccupancyDecision {
  const now = input.now ?? new Date();
  const path = occupancyPath(projectRoot);
  const incoming = resolveOccupancySessionId(input);
  const existing = readOccupancy(projectRoot);
  const live = existing !== null && !isOccupancyExpired(existing, now) ? existing : null;

  if (input.steal === true) {
    return stealOccupancy(projectRoot, { ...input, sessionId: incoming, now });
  }

  if (live !== null && live.sessionId !== incoming) {
    return {
      action: "denied",
      sessionId: incoming,
      record: live,
      path,
      message: formatOccupancyRemediation(live, now),
      code: 1,
    };
  }

  if (input.write === false) {
    return {
      action: live !== null ? "heartbeat" : "claimed",
      sessionId: incoming,
      record: live,
      path,
      message:
        live !== null
          ? `occupancy heartbeat session ${incoming} (intent=${live.intent})`
          : `occupancy claimed session ${incoming} (intent=${input.intent ?? "mutation"})`,
      code: 0,
    };
  }

  return withOccupancyLock(
    projectRoot,
    (fence) => {
      const existingLocked = readOccupancy(projectRoot);
      const liveLocked =
        existingLocked !== null && !isOccupancyExpired(existingLocked, now) ? existingLocked : null;
      if (liveLocked !== null && liveLocked.sessionId !== incoming) {
        return {
          action: "denied" as const,
          sessionId: incoming,
          record: liveLocked,
          path,
          message: formatOccupancyRemediation(liveLocked, now),
          code: 1,
        };
      }
      const record = writeOccupancyRecord(
        projectRoot,
        {
          sessionId: incoming,
          worktreePath: resolve(projectRoot),
          intent: input.intent ?? liveLocked?.intent ?? "mutation",
          claimedAt: liveLocked?.claimedAt ?? now,
          heartbeatAt: now,
          host: input.host ?? liveLocked?.host ?? occupancyHost(input.env),
          address: input.address ?? liveLocked?.address ?? occupancyAddress(input.env),
          retainCapable: input.retainCapable ?? liveLocked?.retainCapable ?? false,
          joinProtocol: input.joinProtocol ?? liveLocked?.joinProtocol ?? "none",
        },
        fence,
      );
      const action: OccupancyAction = liveLocked !== null ? "heartbeat" : "claimed";
      return {
        action,
        sessionId: record.sessionId,
        record,
        path,
        message:
          action === "heartbeat"
            ? `occupancy heartbeat session ${record.sessionId} (intent=${record.intent})`
            : `occupancy claimed session ${record.sessionId} (intent=${record.intent})`,
        code: 0,
      };
    },
    input.lockDeps,
  );
}

export function stealOccupancy(
  projectRoot: string,
  input: ApplyOccupancyInput = {},
): OccupancyDecision {
  const now = input.now ?? new Date();
  const path = occupancyPath(projectRoot);
  if (input.confirm !== true) {
    return {
      action: "denied",
      sessionId: resolveOccupancySessionId(input),
      record: readOccupancy(projectRoot),
      path,
      message: "occupancy:steal requires --confirm after naming the occupant.",
      code: 2,
    };
  }
  const named = input.occupant?.trim() ?? "";
  if (named.length === 0) {
    return {
      action: "denied",
      sessionId: resolveOccupancySessionId(input),
      record: readOccupancy(projectRoot),
      path,
      message: "occupancy:steal requires --occupant <session-id> to name the current occupant.",
      code: 2,
    };
  }
  const existing = readOccupancy(projectRoot);
  const live = existing !== null && !isOccupancyExpired(existing, now) ? existing : null;
  if (live !== null && live.sessionId !== named) {
    return {
      action: "denied",
      sessionId: resolveOccupancySessionId(input),
      record: live,
      path,
      message:
        `occupancy:steal named occupant ${named} does not match live occupant ${live.sessionId}.\n` +
        formatOccupancyRemediation(live, now),
      code: 1,
    };
  }
  return withOccupancyLock(
    projectRoot,
    (fence) => {
      const existingLocked = readOccupancy(projectRoot);
      const liveLocked =
        existingLocked !== null && !isOccupancyExpired(existingLocked, now) ? existingLocked : null;
      if (liveLocked !== null && liveLocked.sessionId !== named) {
        return {
          action: "denied" as const,
          sessionId: resolveOccupancySessionId(input),
          record: liveLocked,
          path,
          message:
            `occupancy:steal named occupant ${named} does not match live occupant ${liveLocked.sessionId}.\n` +
            formatOccupancyRemediation(liveLocked, now),
          code: 1,
        };
      }
      const incoming = resolveOccupancySessionId(input);
      const record = writeOccupancyRecord(
        projectRoot,
        {
          sessionId: incoming,
          worktreePath: resolve(projectRoot),
          intent: input.intent ?? "mutation",
          claimedAt: now,
          heartbeatAt: now,
          host: input.host ?? occupancyHost(input.env),
          address: input.address ?? occupancyAddress(input.env),
          retainCapable: input.retainCapable ?? false,
          joinProtocol: input.joinProtocol ?? "none",
        },
        fence,
      );
      return {
        action: "stolen" as const,
        sessionId: record.sessionId,
        record,
        path,
        message: `occupancy stolen from ${named}; writer is now session ${record.sessionId}`,
        code: 0,
      };
    },
    input.lockDeps,
  );
}

export function releaseOccupancy(
  projectRoot: string,
  input: {
    readonly sessionId?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly now?: Date;
    readonly swarmCloseout?: boolean;
    readonly lockDeps?: LockDeps;
  } = {},
): OccupancyDecision {
  const now = input.now ?? new Date();
  const path = occupancyPath(projectRoot);
  const caller =
    input.sessionId?.trim() || (input.env ?? process.env).DEFT_SESSION_ID?.trim() || "";
  return withOccupancyLock(
    projectRoot,
    (fence) => {
      const existing = readOccupancy(projectRoot);
      if (existing === null) {
        return {
          action: "released" as const,
          sessionId: caller,
          record: null,
          path,
          message: "occupancy already free",
          code: 0,
        };
      }
      const expired = isOccupancyExpired(existing, now);
      const owns = caller.length > 0 && caller === existing.sessionId;
      if (!expired && !owns) {
        return {
          action: "denied" as const,
          sessionId: caller,
          record: existing,
          path,
          message: formatOccupancyRemediation(existing, now),
          code: 1,
        };
      }
      fence();
      const still = readOccupancy(projectRoot);
      if (still === null) {
        return {
          action: "released" as const,
          sessionId: caller,
          record: null,
          path,
          message: "occupancy already free",
          code: 0,
        };
      }
      if (still.sessionId !== existing.sessionId) {
        throw new Error("lock compromised: occupancy session changed before release");
      }
      if (!expired && caller !== still.sessionId) {
        return {
          action: "denied" as const,
          sessionId: caller,
          record: still,
          path,
          message: formatOccupancyRemediation(still, now),
          code: 1,
        };
      }
      removeOccupancyFile(projectRoot, fence);
      return {
        action: "released" as const,
        sessionId: still.sessionId,
        record: null,
        path,
        message: `occupancy released session ${still.sessionId}`,
        code: 0,
      };
    },
    input.lockDeps,
  );
}

export function evaluateOccupancyWriteGate(
  projectRoot: string,
  input: {
    readonly sessionId?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly now?: Date;
  } = {},
): { allow: boolean; message: string | null; occupant: OccupancyRecord | null } {
  const now = input.now ?? new Date();
  const live = liveOccupant(projectRoot, now);
  if (live === null) return { allow: true, message: null, occupant: null };
  const incoming =
    input.sessionId?.trim() || (input.env ?? process.env).DEFT_SESSION_ID?.trim() || "";
  if (incoming.length > 0 && incoming === live.sessionId) {
    return { allow: true, message: null, occupant: live };
  }
  return {
    allow: false,
    message: formatOccupancyRemediation(live, now),
    occupant: live,
  };
}

/** Close-out identity comes from the launch manifest or DEFT_SESSION_ID — never occupancy.json. */
export function releaseSwarmOccupancy(
  projectRoot: string,
  input: {
    readonly sessionId?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly now?: Date;
    readonly lockDeps?: LockDeps;
  } = {},
): OccupancyDecision {
  const env = input.env ?? process.env;
  const sessionId = input.sessionId?.trim() || env.DEFT_SESSION_ID?.trim() || "";
  if (sessionId.length === 0) {
    const occupant = readOccupancy(projectRoot);
    return {
      action: "denied",
      sessionId: "",
      record: occupant,
      path: occupancyPath(projectRoot),
      message:
        "swarm close-out has no occupancy_session_id (manifest missing or predates the field) " +
        "and DEFT_SESSION_ID is unset. Steal with occupancy:steal --confirm --occupant <id>.",
      code: 1,
    };
  }
  return releaseOccupancy(projectRoot, {
    env,
    now: input.now,
    lockDeps: input.lockDeps,
    sessionId,
  });
}

export function runOccupancySteal(
  projectRoot: string,
  input: ApplyOccupancyInput = {},
): OccupancyDecision {
  return stealOccupancy(projectRoot, { ...input, steal: true });
}

function occupancyHost(env: NodeJS.ProcessEnv | undefined): string {
  const value = (env ?? process.env).DEFT_AGENT_ID?.trim();
  return value && value.length > 0 ? value : "none";
}

function occupancyAddress(env: NodeJS.ProcessEnv | undefined): string {
  const value = (env ?? process.env).DEFT_SESSION_NAME?.trim();
  return value && value.length > 0 ? value : "none";
}

function parseOccupancy(payload: unknown, fallbackWorktree: string): OccupancyRecord | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const obj = payload as Record<string, unknown>;
  const sessionId = typeof obj.session_id === "string" ? obj.session_id.trim() : "";
  if (sessionId.length === 0) return null;
  const intentRaw = typeof obj.intent === "string" ? obj.intent : "mutation";
  const intent = (OCCUPANCY_INTENTS as readonly string[]).includes(intentRaw)
    ? (intentRaw as OccupancyIntent)
    : "mutation";
  const claimedAt = parseTimestamp(obj.claimed_at) ?? parseTimestamp(obj.heartbeat_at);
  const heartbeatAt = parseTimestamp(obj.heartbeat_at) ?? claimedAt;
  if (claimedAt === null || heartbeatAt === null) return null;
  const joinRaw = typeof obj.join_protocol === "string" ? obj.join_protocol : "none";
  const joinProtocol = (OCCUPANCY_JOIN_PROTOCOLS as readonly string[]).includes(joinRaw)
    ? (joinRaw as OccupancyJoinProtocol)
    : "none";
  const worktreePath =
    typeof obj.worktree_path === "string" && obj.worktree_path.trim().length > 0
      ? obj.worktree_path
      : fallbackWorktree;
  return {
    schemaVersion:
      typeof obj.schemaVersion === "number" ? obj.schemaVersion : OCCUPANCY_SCHEMA_VERSION,
    sessionId,
    worktreePath,
    intent,
    claimedAt,
    heartbeatAt,
    host: typeof obj.host === "string" && obj.host.length > 0 ? obj.host : "none",
    address: typeof obj.address === "string" && obj.address.length > 0 ? obj.address : "none",
    retainCapable: obj.retain_capable === true,
    joinProtocol,
    raw: { ...obj },
  };
}

function occupancyPayload(record: {
  sessionId: string;
  worktreePath: string;
  intent: OccupancyIntent;
  claimedAt: Date;
  heartbeatAt: Date;
  host: string;
  address: string;
  retainCapable: boolean;
  joinProtocol: OccupancyJoinProtocol;
}): Record<string, unknown> {
  return {
    schemaVersion: OCCUPANCY_SCHEMA_VERSION,
    session_id: record.sessionId,
    worktree_path: record.worktreePath,
    intent: record.intent,
    claimed_at: timestampIso(record.claimedAt),
    heartbeat_at: timestampIso(record.heartbeatAt),
    host: record.host,
    address: record.address,
    retain_capable: record.retainCapable,
    join_protocol: record.joinProtocol,
  };
}

function writeOccupancyRecord(
  projectRoot: string,
  record: {
    sessionId: string;
    worktreePath: string;
    intent: OccupancyIntent;
    claimedAt: Date;
    heartbeatAt: Date;
    host: string;
    address: string;
    retainCapable: boolean;
    joinProtocol: OccupancyJoinProtocol;
  },
  fence: () => void,
): OccupancyRecord {
  const root = resolve(projectRoot);
  const target = occupancyPath(root);
  assertWriteTargetSafe(root, target);
  const dir = dirname(target);
  const tmpName = join(dir, `.occupancy.${process.pid}.occupancy.json.tmp`);
  const payload = occupancyPayload(record);
  const text = `${stableJson(payload, 2)}\n`;
  try {
    containedWrite({ root, target: tmpName, data: text, mode: "create" });
    fence();
    renameSync(tmpName, target);
  } catch (err) {
    try {
      rmSync(tmpName, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
  const parsed = parseOccupancy(payload, record.worktreePath);
  if (parsed === null) {
    throw new Error("occupancy write produced an unreadable record");
  }
  return parsed;
}

function removeOccupancyFile(projectRoot: string, fence: () => void): void {
  const root = resolve(projectRoot);
  fence();
  containedRemove({ root, target: occupancyPath(root) });
}

function withOccupancyLock<T>(
  projectRoot: string,
  fn: (fence: () => void) => T,
  deps: LockDeps = {},
): T {
  return withAppendLock(
    occupancyPath(projectRoot),
    (held) => {
      const fence = (): void => {
        assertAppendLockOwned(held);
      };
      return fn(fence);
    },
    deps,
  );
}
