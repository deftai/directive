/**
 * Spawn occupancy seam (#4066).
 *
 * Four predicates, not a ternary flip of the write gate:
 * 1. Destination inspect (tool_input isolation / worktree path). Absent field
 *    fails closed for implement-class spawn -- do not inherit parent cwd.
 * 2. Unique reservation of that destination before launch.
 * 3. Claim-time refuse on the main path lives in applyWorktreeOccupancy.
 * 4. Occupancy consult on the *destination* tree (live occupant), with a real
 *    actor -- never evaluateOccupancyWriteGate(parentRoot, actor=null).
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  ContainedWriteError,
  ContainedWriteErrorCode,
  containedRemove,
  containedWrite,
} from "../fs/contained-write.js";
import { fieldString, record, toolInputRecord } from "../hooks/classify/payload.js";
import {
  type ChildOccupancyDispatchInput,
  listChildOccupancyLeases,
  recordChildOccupancyLease,
} from "./child-occupancy.js";
import { defaultGitRunner, type GitRunner } from "./git.js";
import { isLinkedWorktreePath, isMainWorktreePath, mainWorktreeRoot } from "./main-worktree.js";
import { liveOccupant } from "./occupancy.js";

export type SpawnDestinationKind = "host-isolation" | "path";

export interface SpawnDestination {
  readonly kind: SpawnDestinationKind;
  readonly path: string | null;
  readonly isolation: string | null;
}

export type SpawnOccupancyDenyReason =
  | "destination-missing"
  | "primary-path"
  | "destination-not-worktree"
  | "destination-foreign"
  | "destination-occupied"
  | "reservation-conflict";

export interface SpawnOccupancyAllow {
  readonly allow: true;
  readonly destination: SpawnDestination;
  readonly incarnation: string;
  readonly reservation: ChildOccupancyDispatchInput;
  readonly reRootPath: string | null;
  readonly hostCanReroot: boolean;
  readonly message: string;
}

export interface SpawnOccupancyDeny {
  readonly allow: false;
  readonly reason: SpawnOccupancyDenyReason;
  readonly destination: SpawnDestination | null;
  readonly message: string;
}

export type SpawnOccupancyDecision = SpawnOccupancyAllow | SpawnOccupancyDeny;

const HOSTS_THAT_REROOT = new Set(["claude", "cursor", "codex"]);

function looksLikePath(value: string): boolean {
  if (value.length === 0) return false;
  if (isAbsolute(value)) return true;
  if (value.includes("/") || value.includes("\\")) return true;
  if (value.startsWith(".deft-scratch") || value.startsWith(".deft")) return true;
  return false;
}

/**
 * Spawn destination from tool_input only. Top-level payload cwd is the parent's
 * hook execution directory -- treating it as the child destination would inherit
 * cwd, which this seam refuses.
 */
export function inspectSpawnDestination(payload: unknown): SpawnDestination | null {
  const input = record(payload);
  if (input === null) return null;
  const nested = toolInputRecord(input);
  const toolInput = nested ?? {};
  const isolation =
    fieldString(toolInput, "isolation") ??
    fieldString(toolInput, "Isolation") ??
    (nested === null ? fieldString(input, "isolation") : null);
  const pathRaw =
    fieldString(toolInput, "worktree_path") ??
    fieldString(toolInput, "worktreePath") ??
    fieldString(toolInput, "worktree") ??
    fieldString(toolInput, "cwd") ??
    fieldString(toolInput, "working_directory") ??
    fieldString(toolInput, "workingDirectory") ??
    fieldString(toolInput, "workdir");
  const path = pathRaw !== null && looksLikePath(pathRaw) ? pathRaw : null;
  const isolationWorktree = isolation !== null && isolation.toLowerCase() === "worktree";
  if (path !== null) {
    return { kind: "path", path, isolation: isolationWorktree ? "worktree" : isolation };
  }
  if (isolationWorktree) {
    return { kind: "host-isolation", path: null, isolation: "worktree" };
  }
  return null;
}

function resolveDestinationPath(payloadRoot: string, destination: SpawnDestination): string | null {
  if (destination.path === null) return null;
  return isAbsolute(destination.path)
    ? resolve(destination.path)
    : resolve(payloadRoot, destination.path);
}

function parentIdFromEnv(environ: NodeJS.ProcessEnv): string {
  const explicit = environ.DEFT_SESSION_ID?.trim();
  if (explicit) return explicit;
  const named = environ.DEFT_SESSION_NAME?.trim();
  if (named) return named;
  const grok = environ.GROK_SESSION_ID?.trim();
  if (grok) return grok;
  return "none";
}

function agentIdFromPayload(payload: unknown, incarnation: string): string {
  const input = record(payload);
  const toolInput = input !== null ? (toolInputRecord(input) ?? input) : null;
  const named =
    toolInput !== null
      ? (fieldString(toolInput, "agent_id") ??
        fieldString(toolInput, "agentId") ??
        fieldString(toolInput, "name"))
      : null;
  if (named !== null) return named;
  return `spawn-${incarnation.slice(0, 8)}`;
}

function reservationLockRoot(storeRoot: string): string {
  const root = resolve(storeRoot);
  return mainWorktreeRoot(root) ?? root;
}

function existingDispatchReservation(storeRoot: string, worktreePath: string) {
  const want = resolve(worktreePath);
  const roots = [resolve(storeRoot)];
  const main = mainWorktreeRoot(storeRoot);
  if (main !== null && !sameTree(main, storeRoot)) roots.push(main);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const rec of listChildOccupancyLeases(root)) {
      if (rec.provenance !== "dispatch") continue;
      const recorded = resolve(rec.worktreePath);
      if (sameTree(recorded, want)) return rec;
    }
  }
  return null;
}

export function evaluateImplementSpawnOccupancy(input: {
  readonly payload: unknown;
  readonly payloadRoot: string;
  readonly host: string;
  readonly environ?: NodeJS.ProcessEnv;
  readonly runGit?: GitRunner;
  readonly now?: Date;
  readonly parentId?: string;
}): SpawnOccupancyDecision {
  const payloadRoot = resolve(input.payloadRoot);
  const environ = input.environ ?? process.env;
  const runGit = input.runGit ?? defaultGitRunner;
  const destination = inspectSpawnDestination(input.payload);
  if (destination === null) {
    return {
      allow: false,
      reason: "destination-missing",
      destination: null,
      message:
        "Directive denied implement-class spawn: no worktree destination on the spawn payload " +
        "(tool_input.isolation=worktree, worktree_path, or cwd). Spawned mutating work takes " +
        "its own worktree; do not inherit the parent checkout. Grok spawn_subagent cannot " +
        "rewrite input -- pass cwd/worktree_path before the spawn primitive.",
    };
  }

  const destPath = resolveDestinationPath(payloadRoot, destination);
  const hostCanReroot = HOSTS_THAT_REROOT.has(input.host);

  if (destPath === null && !hostCanReroot) {
    return {
      allow: false,
      reason: "destination-missing",
      destination,
      message:
        "Directive denied implement-class spawn: this host cannot re-root PreToolUse input, " +
        "and isolation=worktree has no concrete cwd/worktree_path. Grok spawn_subagent cannot " +
        "rewrite input -- pass cwd to a reserved linked worktree before the spawn primitive.",
    };
  }

  if (destPath !== null && isMainWorktreePath(destPath, runGit)) {
    return {
      allow: false,
      reason: "primary-path",
      destination,
      message:
        "Directive denied implement-class spawn onto the primary checkout. Spawned mutating " +
        "work takes a linked worktree. A spawn payload cannot name a primary-claim exception; " +
        "that exception is occupancy-claim only (release-cut, policy-restore, " +
        "operator-default-branch). " +
        (hostCanReroot
          ? "Pass isolation=worktree or a linked worktree_path."
          : "This host cannot re-root spawn input; pass cwd to a linked worktree."),
    };
  }

  if (destPath !== null && existsSync(destPath) && !isLinkedWorktreePath(destPath)) {
    return {
      allow: false,
      reason: "destination-not-worktree",
      destination,
      message:
        `Directive denied spawn: destination ${destPath} exists and is not a linked worktree. ` +
        "Spawned mutating work takes a linked worktree, not an ordinary directory.",
    };
  }

  if (destPath !== null && existsSync(destPath)) {
    const destRepo = mainWorktreeRoot(destPath, runGit);
    const parentRepo = mainWorktreeRoot(payloadRoot, runGit);
    if (destRepo !== null && parentRepo !== null && !sameTree(destRepo, parentRepo)) {
      return {
        allow: false,
        reason: "destination-foreign",
        destination,
        message:
          `Directive denied spawn: destination ${destPath} is a linked worktree of a foreign repository. ` +
          "Spawned mutating work takes a linked worktree of this repo.",
      };
    }
  }

  if (destPath !== null) {
    const live = liveOccupant(destPath, input.now);
    if (live !== null) {
      return {
        allow: false,
        reason: "destination-occupied",
        destination,
        message:
          `Directive denied spawn: destination worktree is occupied by session ${live.sessionId} ` +
          `(intent=${live.intent}). Use another worktree. Do not grant across hosts onto that lease ` +
          "and do not take over the primary checkout.",
      };
    }
    const existing = existingDispatchReservation(payloadRoot, destPath);
    if (existing !== null) {
      return {
        allow: false,
        reason: "reservation-conflict",
        destination,
        message:
          `Directive denied spawn: destination ${destPath} is already reserved for dispatch ` +
          `${existing.incarnation} (agent ${existing.agentId}). Own worktree means a unique ` +
          "reservation, not a shared linked tree.",
      };
    }
  }

  const incarnation = randomUUID();
  const parentId = (input.parentId?.trim() || parentIdFromEnv(environ)).trim() || "none";
  const agentId = agentIdFromPayload(input.payload, incarnation);
  // Pathless isolation=worktree is in-AC only for hosts that re-root.
  // Grok cannot rewrite PreToolUse input; that arm is denied above.
  const reservation: ChildOccupancyDispatchInput = {
    agentId,
    parentId,
    occupancyOwner: parentId,
    worktreePath: destPath ?? join(payloadRoot, ".deft", "spawn-pending", incarnation),
    identitySourceKind: input.host === "grok" ? "host-env" : "payload",
    incarnation,
    provenance: "dispatch",
  };

  const reRootPath = destPath;
  const rerootNote = hostCanReroot
    ? reRootPath !== null
      ? ` Hook payload will re-root onto ${reRootPath}.`
      : " Host isolation=worktree re-roots the child payload."
    : " This host cannot re-root PreToolUse input; the child must start in the reserved worktree.";

  return {
    allow: true,
    destination,
    incarnation,
    reservation,
    reRootPath,
    hostCanReroot,
    message: `Directive reserved spawn worktree incarnation ${incarnation}.${rerootNote}`,
  };
}

function reservationDigestKey(destPath: string): string {
  const lexical = resolve(destPath);
  const missing: string[] = [];
  let cursor = lexical;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(basename(cursor));
    cursor = parent;
  }
  let existing = cursor;
  try {
    if (existsSync(cursor)) existing = realpathSync(cursor);
  } catch {
    existing = cursor;
  }
  const canonical = missing.length === 0 ? existing : join(existing, ...missing);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function reservationLockPath(storeRoot: string, destPath: string): string {
  const digest = createHash("sha256")
    .update(reservationDigestKey(destPath))
    .digest("hex")
    .slice(0, 32);
  return join(storeRoot, ".deft", "spawn-reservations", digest);
}

/** Incarnation written by persistSpawnReservation dest-lock, or null. */
export function readSpawnReservationIncarnation(
  storeRoot: string,
  destPath: string,
): string | null {
  const lockRoot = reservationLockRoot(resolve(storeRoot));
  const target = reservationLockPath(lockRoot, destPath);
  if (!existsSync(target)) return null;
  const text = readFileSync(target, "utf8").trim();
  return text.length > 0 ? text : null;
}

export type PersistSpawnReservationResult = { ok: true } | { ok: false; reason: "conflict" };

/** Persist the dispatch reservation after other spawn gates have allowed. */
export function persistSpawnReservation(
  storeRoot: string,
  reservation: ChildOccupancyDispatchInput,
): PersistSpawnReservationResult {
  const root = resolve(storeRoot);
  if (!existsSync(root)) return { ok: true };
  const dest = resolve(reservation.worktreePath);
  const incarnation = reservation.incarnation?.trim() ?? "";
  if (incarnation.length === 0) return { ok: false, reason: "conflict" };
  // Dest-keyed lock lives under the shared git common-dir (main clone) so two
  // parent worktrees cannot both first-create the same destination.
  const lockRoot = reservationLockRoot(root);
  const skipDestLock = sameTree(dest, lockRoot);
  if (!skipDestLock) {
    try {
      containedWrite({
        root: lockRoot,
        target: reservationLockPath(lockRoot, dest),
        data: incarnation,
        mode: "create",
        encoding: "utf8",
      });
    } catch (err) {
      if (err instanceof ContainedWriteError && err.code === ContainedWriteErrorCode.EXISTS) {
        return { ok: false, reason: "conflict" };
      }
      throw err;
    }
  }
  recordChildOccupancyLease(root, reservation);
  if (existsSync(dest) && dest !== root) {
    recordChildOccupancyLease(dest, reservation);
  }
  return { ok: true };
}

/**
 * Release a dest-lock only when it still names this incarnation.
 * Path-only or stale-incarnation cleanup must not delete a successor
 * reservation (#4066).
 */
export function releaseSpawnReservation(
  storeRoot: string,
  destPath: string,
  incarnation?: string,
): boolean {
  const want = (incarnation ?? "").trim();
  if (want.length === 0) return false;
  const root = resolve(storeRoot);
  const lockRoot = reservationLockRoot(root);
  let released = false;
  if (existsSync(root)) {
    released = releaseLockIfIncarnation(root, destPath, want) || released;
  }
  if (!sameTree(lockRoot, root) && existsSync(lockRoot)) {
    released = releaseLockIfIncarnation(lockRoot, destPath, want) || released;
  }
  return released;
}

function readLockIncarnation(storeRoot: string, destPath: string): string | null {
  const target = reservationLockPath(resolve(storeRoot), destPath);
  if (!existsSync(target)) return null;
  const text = readFileSync(target, "utf8").trim();
  return text.length > 0 ? text : null;
}

function releaseLockIfIncarnation(
  storeRoot: string,
  destPath: string,
  incarnation: string,
): boolean {
  const current = readLockIncarnation(storeRoot, destPath);
  if (current === null || current !== incarnation) return false;
  containedRemove({ root: storeRoot, target: reservationLockPath(storeRoot, destPath) });
  return true;
}

function sameTree(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  if (process.platform === "win32") return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/**
 * True when `candidate` is a dispatcher-allocated child of `storeRoot`.
 * Path match alone is not enough: bind git common-dir (repo), presented and
 * current dest-lock incarnation, parent, and live occupant so a stale unoccupied
 * dispatch record cannot rewrite identity against a reused tree. Dest-lock does
 * not substitute a missing presented incarnation.
 */
export function allocatedWorktreeMatches(
  storeRoot: string,
  candidate: string,
  opts: {
    readonly parentId?: string;
    readonly incarnation?: string;
    readonly runGit?: GitRunner;
  } = {},
): boolean {
  const parentId = opts.parentId?.trim() ?? "";
  if (parentId.length === 0) return false;
  const presentedIncarnation = opts.incarnation?.trim() ?? "";
  if (presentedIncarnation.length === 0 || presentedIncarnation === "missing") return false;
  const runGit = opts.runGit ?? defaultGitRunner;
  const want = resolve(candidate);
  const root = resolve(storeRoot);
  if (!existsSync(root)) return false;
  const storeRepo = mainWorktreeRoot(root, runGit);
  const candidateRepo = mainWorktreeRoot(want, runGit);
  if (storeRepo === null || candidateRepo === null) return false;
  if (!sameTree(storeRepo, candidateRepo)) return false;
  if (!isLinkedWorktreePath(want)) return false;
  const currentIncarnation = readSpawnReservationIncarnation(root, want);
  if (currentIncarnation === null || currentIncarnation.length === 0) return false;
  if (presentedIncarnation !== currentIncarnation) {
    return false;
  }
  for (const rec of listChildOccupancyLeases(root)) {
    if (rec.provenance !== "dispatch") continue;
    if (rec.incarnation.length === 0 || rec.incarnation === "missing") continue;
    if (rec.incarnation !== currentIncarnation) continue;
    if (rec.occupancyOwner.trim().length === 0) continue;
    if (rec.parentId !== parentId) continue;
    const recorded = resolve(rec.worktreePath);
    if (!sameTree(recorded, want)) continue;
    const live = liveOccupant(want);
    if (live !== null && live.sessionId !== rec.occupancyOwner && live.sessionId !== parentId) {
      continue;
    }
    return true;
  }
  return false;
}
