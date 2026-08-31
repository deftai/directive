/**
 * Dispatch-recorded child occupancy leases (#3999).
 *
 * A parent records the child's occupancy owner and the exact worktree root at
 * dispatch in `.deft/child-occupancy/` — lease-gated, not `.deft-scratch/**`.
 * The orchestration terminal transition already carries agent_id / parent_id /
 * phase; this store is the missing occupancy-owner datum. Release reuses
 * `releaseOccupancy` under the occupancy lock and only fires when the recorded
 * child is still the current owner of the recorded tree.
 *
 * Per identity-source kind: `host-env` children are strangers and strand —
 * that is the defect. `payload` parents share one id with their children, so
 * the same transition is a no-op; auto-release would drop a live parent lease
 * mid-flight. Swarm close-out of the launcher's occupancy_session_id is not
 * the precedent and is not copied here.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { containedRemove, containedWrite } from "../fs/contained-write.js";
import type { LockDeps } from "../slice/lock.js";
import { hookHostIdentitySource } from "./host-session-owner.js";
import { stableJson } from "./json.js";
import { type OccupancyDecision, readOccupancy, releaseOccupancy } from "./occupancy.js";

export const CHILD_OCCUPANCY_SCHEMA_VERSION = 1;
export const CHILD_OCCUPANCY_DIR = [".deft", "child-occupancy"] as const;
export const CHILD_OCCUPANCY_IDENTITY_SOURCE_KINDS = ["host-env", "payload"] as const;
export type ChildOccupancyIdentitySourceKind =
  (typeof CHILD_OCCUPANCY_IDENTITY_SOURCE_KINDS)[number];

export interface ChildOccupancyRecord {
  readonly schemaVersion: number;
  readonly agentId: string;
  readonly parentId: string;
  readonly occupancyOwner: string;
  readonly worktreePath: string;
  readonly identitySourceKind: ChildOccupancyIdentitySourceKind;
}

export interface ChildOccupancyDispatchInput {
  readonly agentId: string;
  readonly parentId: string;
  readonly occupancyOwner: string;
  readonly worktreePath: string;
  readonly identitySourceKind: ChildOccupancyIdentitySourceKind;
}

export type ChildOccupancyReleaseReason =
  | "released"
  | "already-free"
  | "owner-changed"
  | "payload-skip"
  | "missing-record"
  | "denied";

export interface ChildOccupancyReleaseResult {
  readonly reason: ChildOccupancyReleaseReason;
  readonly record: ChildOccupancyRecord | null;
  readonly occupancy: OccupancyDecision | null;
}

function isIdentitySourceKind(value: string): value is ChildOccupancyIdentitySourceKind {
  return (CHILD_OCCUPANCY_IDENTITY_SOURCE_KINDS as readonly string[]).includes(value);
}

/** Filename-safe agent id; the payload keeps the original. */
export function childOccupancyFileSegment(agentId: string): string {
  let cleaned = "";
  for (const ch of agentId.trim()) {
    if (
      (ch >= "A" && ch <= "Z") ||
      (ch >= "a" && ch <= "z") ||
      (ch >= "0" && ch <= "9") ||
      ch === "." ||
      ch === "_" ||
      ch === "-"
    ) {
      cleaned += ch;
    } else {
      cleaned += "-";
    }
  }
  let start = 0;
  let end = cleaned.length;
  while (start < end && (cleaned[start] === "-" || cleaned[start] === ".")) start += 1;
  while (end > start && (cleaned[end - 1] === "-" || cleaned[end - 1] === ".")) end -= 1;
  cleaned = cleaned.slice(start, end);
  return cleaned.length > 0 ? cleaned : "agent";
}

export function childOccupancyRelpath(agentId: string): string[] {
  return [...CHILD_OCCUPANCY_DIR, `${childOccupancyFileSegment(agentId)}.json`];
}

export function childOccupancyPath(storeRoot: string, agentId: string): string {
  return join(resolve(storeRoot), ...childOccupancyRelpath(agentId));
}

export function childOccupancyIdentitySourceKind(
  host: string,
): ChildOccupancyIdentitySourceKind | null {
  const source = hookHostIdentitySource(host);
  if (source === null) return null;
  return source.kind;
}

function parseChildOccupancyRecord(payload: unknown): ChildOccupancyRecord | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const obj = payload as Record<string, unknown>;
  const agentId = typeof obj.agent_id === "string" ? obj.agent_id.trim() : "";
  const parentId = typeof obj.parent_id === "string" ? obj.parent_id.trim() : "";
  const occupancyOwner = typeof obj.occupancy_owner === "string" ? obj.occupancy_owner.trim() : "";
  const worktreePath = typeof obj.worktree_path === "string" ? obj.worktree_path.trim() : "";
  const kindRaw =
    typeof obj.identity_source_kind === "string" ? obj.identity_source_kind.trim() : "";
  if (
    agentId.length === 0 ||
    parentId.length === 0 ||
    occupancyOwner.length === 0 ||
    worktreePath.length === 0 ||
    !isIdentitySourceKind(kindRaw)
  ) {
    return null;
  }
  return {
    schemaVersion:
      typeof obj.schemaVersion === "number" ? obj.schemaVersion : CHILD_OCCUPANCY_SCHEMA_VERSION,
    agentId,
    parentId,
    occupancyOwner,
    worktreePath,
    identitySourceKind: kindRaw,
  };
}

export function readChildOccupancyLease(
  storeRoot: string,
  agentId: string,
): ChildOccupancyRecord | null {
  const path = childOccupancyPath(storeRoot, agentId);
  try {
    if (!existsSync(path)) return null;
    return parseChildOccupancyRecord(JSON.parse(readFileSync(path, { encoding: "utf8" })));
  } catch {
    return null;
  }
}

/**
 * Parent-only write at dispatch. Workers cannot author this store: `.deft/` is
 * not assist-scratch, so a mutation write is occupancy-gated and an assist
 * writer does not get the scratch carve-out.
 */
export function recordChildOccupancyLease(
  storeRoot: string,
  input: ChildOccupancyDispatchInput,
): ChildOccupancyRecord {
  const agentId = input.agentId.trim();
  const parentId = input.parentId.trim();
  const occupancyOwner = input.occupancyOwner.trim();
  const worktreePath = resolve(input.worktreePath.trim());
  if (agentId.length === 0) throw new Error("recordChildOccupancyLease needs agentId");
  if (parentId.length === 0) throw new Error("recordChildOccupancyLease needs parentId");
  if (occupancyOwner.length === 0) {
    throw new Error("recordChildOccupancyLease needs occupancyOwner");
  }
  if (input.worktreePath.trim().length === 0) {
    throw new Error("recordChildOccupancyLease needs worktreePath");
  }
  const record: ChildOccupancyRecord = {
    schemaVersion: CHILD_OCCUPANCY_SCHEMA_VERSION,
    agentId,
    parentId,
    occupancyOwner,
    worktreePath,
    identitySourceKind: input.identitySourceKind,
  };
  const root = resolve(storeRoot);
  const relpath = childOccupancyRelpath(agentId);
  mkdirSync(join(root, ...CHILD_OCCUPANCY_DIR), { recursive: true });
  containedWrite({
    root,
    target: join(...relpath),
    data: `${stableJson(
      {
        schemaVersion: record.schemaVersion,
        agent_id: record.agentId,
        parent_id: record.parentId,
        occupancy_owner: record.occupancyOwner,
        worktree_path: record.worktreePath,
        identity_source_kind: record.identitySourceKind,
      },
      2,
    )}\n`,
    mode: "replace",
  });
  return record;
}

function removeChildOccupancyLease(storeRoot: string, agentId: string): void {
  const root = resolve(storeRoot);
  const relpath = childOccupancyRelpath(agentId);
  const abs = join(root, ...relpath);
  if (!existsSync(abs)) return;
  containedRemove({ root, target: join(...relpath) });
}

/**
 * Compare-and-release under the occupancy lock. Caller identity is the id the
 * parent recorded at dispatch — not the occupant currently named in the lease
 * file, and not a field on a worker-authored heartbeat.
 */
export function releaseChildOccupancyOnTerminal(
  storeRoot: string,
  input: {
    readonly agentId: string;
    readonly now?: Date;
    readonly lockDeps?: LockDeps;
  },
): ChildOccupancyReleaseResult {
  const agentId = input.agentId.trim();
  if (agentId.length === 0) {
    return { reason: "missing-record", record: null, occupancy: null };
  }
  const record = readChildOccupancyLease(storeRoot, agentId);
  if (record === null) {
    return { reason: "missing-record", record: null, occupancy: null };
  }
  if (record.identitySourceKind === "payload") {
    return { reason: "payload-skip", record, occupancy: null };
  }
  const tree = resolve(record.worktreePath);
  const now = input.now ?? new Date();
  const live = readOccupancy(tree);
  if (live === null) {
    removeChildOccupancyLease(storeRoot, agentId);
    return { reason: "already-free", record, occupancy: null };
  }
  if (live.sessionId !== record.occupancyOwner) {
    return { reason: "owner-changed", record, occupancy: null };
  }
  const occupancy = releaseOccupancy(tree, {
    sessionId: record.occupancyOwner,
    now,
    env: {},
    lockDeps: input.lockDeps,
  });
  if (occupancy.action === "released") {
    removeChildOccupancyLease(storeRoot, agentId);
    if (resolve(storeRoot) !== tree) removeChildOccupancyLease(tree, agentId);
    return { reason: "released", record, occupancy };
  }
  return { reason: "denied", record, occupancy };
}

/**
 * Worktree guesses for a heartbeat file. Canonical layout is
 * `<worktree>/.deft-scratch/subagent-status/<agent>.json`; cwd is the fallback
 * when the scratch dir was passed as a custom path.
 */
export function worktreeCandidatesForHeartbeat(
  heartbeatPath: string,
  cwd: string,
): readonly string[] {
  const fromHeartbeat = resolve(heartbeatPath, "..", "..", "..");
  const fromCwd = resolve(cwd);
  if (fromHeartbeat === fromCwd) return [fromHeartbeat];
  return [fromHeartbeat, fromCwd];
}
