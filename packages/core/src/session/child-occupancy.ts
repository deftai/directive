/**
 * Dispatch-recorded child occupancy leases (#3999 / #4066).
 *
 * A parent records the child's occupancy owner, exact worktree root, and a
 * non-reused dispatch incarnation at spawn in `.deft/child-occupancy/`.
 * Terminal release is dispatcher-owned: parent-id match, incarnation match,
 * skip invalid heartbeats, refuse a tree that is not the heartbeat tree or a
 * dispatcher-allocated tree. Ordinary self-claim records are not close-out.
 *
 * Payload-kind skip is same-tree logic: after own-tree claim, tree-scoped
 * compare-and-release is safe when the recorded path is a linked worktree
 * distinct from the observer root.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { containedRemove, containedWrite } from "../fs/contained-write.js";
import type { LockDeps } from "../slice/lock.js";
import { hookHostIdentitySource } from "./host-session-owner.js";
import { stableJson } from "./json.js";
import { isLinkedWorktreePath, mainWorktreeRoot } from "./main-worktree.js";
import { type OccupancyDecision, readOccupancy, releaseOccupancy } from "./occupancy.js";

export const CHILD_OCCUPANCY_SCHEMA_VERSION = 2;
export const CHILD_OCCUPANCY_DIR = [".deft", "child-occupancy"] as const;
export const CHILD_OCCUPANCY_IDENTITY_SOURCE_KINDS = ["host-env", "payload"] as const;
export type ChildOccupancyIdentitySourceKind =
  (typeof CHILD_OCCUPANCY_IDENTITY_SOURCE_KINDS)[number];
export const CHILD_OCCUPANCY_PROVENANCES = ["dispatch", "claim"] as const;
export type ChildOccupancyProvenance = (typeof CHILD_OCCUPANCY_PROVENANCES)[number];

export interface ChildOccupancyRecord {
  readonly schemaVersion: number;
  readonly agentId: string;
  readonly parentId: string;
  readonly occupancyOwner: string;
  readonly worktreePath: string;
  readonly identitySourceKind: ChildOccupancyIdentitySourceKind;
  readonly incarnation: string;
  readonly provenance: ChildOccupancyProvenance;
}

export interface ChildOccupancyDispatchInput {
  readonly agentId: string;
  readonly parentId: string;
  readonly occupancyOwner: string;
  readonly worktreePath: string;
  readonly identitySourceKind: ChildOccupancyIdentitySourceKind;
  readonly incarnation?: string;
  readonly provenance?: ChildOccupancyProvenance;
}

export type ChildOccupancyReleaseReason =
  | "released"
  | "already-free"
  | "owner-changed"
  | "payload-skip"
  | "missing-record"
  | "denied"
  | "claim-provenance"
  | "parent-mismatch"
  | "incarnation-mismatch"
  | "invalid-heartbeat"
  | "tree-not-allocated";

export interface ChildOccupancyReleaseResult {
  readonly reason: ChildOccupancyReleaseReason;
  readonly record: ChildOccupancyRecord | null;
  readonly occupancy: OccupancyDecision | null;
}

function isIdentitySourceKind(value: string): value is ChildOccupancyIdentitySourceKind {
  return (CHILD_OCCUPANCY_IDENTITY_SOURCE_KINDS as readonly string[]).includes(value);
}

function isProvenance(value: string): value is ChildOccupancyProvenance {
  return (CHILD_OCCUPANCY_PROVENANCES as readonly string[]).includes(value);
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
  const incarnation = typeof obj.incarnation === "string" ? obj.incarnation.trim() : "";
  const provenanceRaw = typeof obj.provenance === "string" ? obj.provenance.trim() : "claim";
  if (
    agentId.length === 0 ||
    parentId.length === 0 ||
    occupancyOwner.length === 0 ||
    worktreePath.length === 0 ||
    !isIdentitySourceKind(kindRaw)
  ) {
    return null;
  }
  const provenance: ChildOccupancyProvenance = isProvenance(provenanceRaw)
    ? provenanceRaw
    : "claim";
  return {
    schemaVersion:
      typeof obj.schemaVersion === "number" ? obj.schemaVersion : CHILD_OCCUPANCY_SCHEMA_VERSION,
    agentId,
    parentId,
    occupancyOwner,
    worktreePath,
    identitySourceKind: kindRaw,
    incarnation,
    provenance,
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

export function listChildOccupancyLeases(storeRoot: string): readonly ChildOccupancyRecord[] {
  const dir = join(resolve(storeRoot), ...CHILD_OCCUPANCY_DIR);
  try {
    if (!existsSync(dir)) return [];
  } catch {
    return [];
  }
  const out: ChildOccupancyRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = parseChildOccupancyRecord(
        JSON.parse(readFileSync(join(dir, name), { encoding: "utf8" })),
      );
      if (parsed !== null) out.push(parsed);
    } catch {
      /* skip malformed */
    }
  }
  return out;
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
  const incarnation = (input.incarnation ?? "").trim();
  const provenance = input.provenance ?? "dispatch";
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
    incarnation: incarnation.length > 0 ? incarnation : randomUUID(),
    provenance,
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
        incarnation: record.incarnation,
        provenance: record.provenance,
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

function sameTree(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  if (process.platform === "win32") return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function isSpawnPendingPlaceholder(worktreePath: string, storeRoot: string): boolean {
  const pendingRoot = join(resolve(storeRoot), ".deft", "spawn-pending");
  const recorded = resolve(worktreePath);
  const rel = relative(pendingRoot, recorded);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

function sameRepository(left: string, right: string): boolean {
  const a = mainWorktreeRoot(left);
  const b = mainWorktreeRoot(right);
  if (a === null || b === null) return false;
  return sameTree(a, b);
}

/**
 * Pathless isolation=worktree records a spawn-pending placeholder. Terminal
 * cleanup binds the host-created heartbeat tree when it is a linked worktree
 * of the same repo and not the parent observer root.
 */
function bindReleaseTree(
  storeRoot: string,
  record: ChildOccupancyRecord,
  heartbeatTree: string | null,
  observerRoot: string,
): string {
  const tree = resolve(record.worktreePath);
  if (heartbeatTree === null) return tree;
  if (sameTree(tree, heartbeatTree)) return tree;
  if (
    isSpawnPendingPlaceholder(tree, storeRoot) &&
    isLinkedWorktreePath(heartbeatTree) &&
    !sameTree(heartbeatTree, observerRoot) &&
    sameRepository(storeRoot, heartbeatTree)
  ) {
    return heartbeatTree;
  }
  return tree;
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
    readonly parentId?: string;
    readonly incarnation?: string;
    readonly heartbeatWorktree?: string;
    readonly heartbeatFailures?: readonly string[];
    readonly observerRoot?: string;
  },
): ChildOccupancyReleaseResult {
  const agentId = input.agentId.trim();
  if (agentId.length === 0) {
    return { reason: "missing-record", record: null, occupancy: null };
  }
  if (input.heartbeatFailures !== undefined && input.heartbeatFailures.length > 0) {
    return { reason: "invalid-heartbeat", record: null, occupancy: null };
  }
  const record = readChildOccupancyLease(storeRoot, agentId);
  if (record === null) {
    return { reason: "missing-record", record: null, occupancy: null };
  }
  if (record.provenance !== "dispatch") {
    return { reason: "claim-provenance", record, occupancy: null };
  }
  if (record.incarnation.length === 0 || record.incarnation === "missing") {
    return { reason: "incarnation-mismatch", record, occupancy: null };
  }
  const presentedIncarnation = (input.incarnation ?? "").trim();
  if (presentedIncarnation.length === 0 || presentedIncarnation !== record.incarnation) {
    return { reason: "incarnation-mismatch", record, occupancy: null };
  }
  const presentedParent = (input.parentId ?? "").trim();
  if (presentedParent.length > 0 && presentedParent !== record.parentId) {
    return { reason: "parent-mismatch", record, occupancy: null };
  }
  const tree = resolve(record.worktreePath);
  const heartbeatTree =
    input.heartbeatWorktree !== undefined && input.heartbeatWorktree.trim().length > 0
      ? resolve(input.heartbeatWorktree)
      : null;
  const observerRoot =
    input.observerRoot !== undefined && input.observerRoot.trim().length > 0
      ? resolve(input.observerRoot)
      : resolve(storeRoot);
  const boundTree = bindReleaseTree(storeRoot, record, heartbeatTree, observerRoot);
  if (
    heartbeatTree !== null &&
    !sameTree(boundTree, heartbeatTree) &&
    !sameTree(tree, observerRoot)
  ) {
    return { reason: "tree-not-allocated", record, occupancy: null };
  }
  if (record.identitySourceKind === "payload") {
    const linked = isLinkedWorktreePath(boundTree);
    if (!linked || sameTree(boundTree, observerRoot)) {
      return { reason: "payload-skip", record, occupancy: null };
    }
  }
  const now = input.now ?? new Date();
  const live = readOccupancy(boundTree);
  if (live === null) {
    removeChildOccupancyLease(storeRoot, agentId);
    return { reason: "already-free", record, occupancy: null };
  }
  if (live.sessionId !== record.occupancyOwner) {
    return { reason: "owner-changed", record, occupancy: null };
  }
  const occupancy = releaseOccupancy(boundTree, {
    sessionId: record.occupancyOwner,
    now,
    env: {},
    lockDeps: input.lockDeps,
  });
  if (occupancy.action === "released") {
    removeChildOccupancyLease(storeRoot, agentId);
    if (resolve(storeRoot) !== boundTree) removeChildOccupancyLease(boundTree, agentId);
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
