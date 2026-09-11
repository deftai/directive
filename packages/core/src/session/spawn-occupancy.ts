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
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  ContainedWriteError,
  ContainedWriteErrorCode,
  containedRemove,
  containedWrite,
} from "../fs/contained-write.js";
import { fieldPresent, fieldString, record, toolInputRecord } from "../hooks/classify/payload.js";
import {
  appliesGrokSpawnDestContract,
  isProcessOnlyCriticSpawn,
  SPAWN_CLASS_RECOVERY,
} from "../hooks/readonly.js";
import {
  type ChildOccupancyDispatchInput,
  type ChildOccupancyRecord,
  childOccupancyRelpath,
  listChildOccupancyLeases,
  recordChildOccupancyLease,
} from "./child-occupancy.js";
import { defaultGitRunner, type GitRunner, gitCommonDir } from "./git.js";
import { isLinkedWorktreePath, isMainWorktreePath, mainWorktreeRoot } from "./main-worktree.js";
import {
  evaluateOccupancyWriteGate,
  grantOccupancyMembership,
  liveOccupancyGrants,
  liveOccupant,
  type OccupancyWriteGateResult,
} from "./occupancy.js";

export type SpawnDestinationKind = "host-isolation" | "path";

export interface SpawnDestination {
  readonly kind: SpawnDestinationKind;
  readonly path: string | null;
  readonly isolation: string | null;
}

export type SpawnOccupancyDenyReason =
  | "destination-missing"
  | "invalid-extra-destination"
  | "primary-path"
  | "destination-not-worktree"
  | "destination-foreign"
  | "destination-occupied"
  | "reservation-conflict";

export interface SpawnOccupancyAllow {
  readonly allow: true;
  readonly destination: SpawnDestination;
  readonly incarnation: string | null;
  readonly reservation: ChildOccupancyDispatchInput | null;
  /** Set when dest consult was skipped; reservation is null (#4241). */
  readonly exemption: "process-only-critic" | null;
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

export interface SpawnOccupancyConsultAllow {
  readonly allow: true;
  readonly destProven: boolean;
  readonly destination: SpawnDestination;
  readonly destPath: string | null;
  readonly reRootPath: string | null;
  readonly hostCanReroot: boolean;
  readonly message: string;
  readonly parentId: string;
  /**
   * Leftover dest-lock incarnation to release before minting a new one (#4254).
   * Consult does not mutate; evaluate/dispatcher leftover-release then mint.
   */
  readonly leftoverIncarnation: string | null;
  /** Cursor nursery inherit (#4295): payload root is the dest-rooted window. */
  readonly nurseryInherit: boolean;
}

export interface SpawnOccupancyConsultDeny {
  readonly allow: false;
  readonly destProven: false;
  readonly reason: SpawnOccupancyDenyReason;
  readonly destination: SpawnDestination | null;
  readonly destPath: string | null;
  readonly message: string;
  readonly parentId: string;
}

export type SpawnOccupancyConsult = SpawnOccupancyConsultAllow | SpawnOccupancyConsultDeny;

const HOSTS_THAT_REROOT = new Set(["claude", "cursor", "codex"]);
// #4279: Cursor Task dest-key bind waits on a recorded PreToolUse payload.
// HOSTS_THAT_REROOT for Task stays unbound until that measurement.

/** Fence-in-place (#4295) stays parked until these are measured. Comment 5611146439 stands. */
export const FENCE_IN_PLACE_PARKED_UNTIL = [
  "Shell updated_input.cwd",
  "Write/ApplyPatch path rewrite",
  "Composer visibility of gitignored .deft-scratch/worktrees/",
] as const;

export const SPAWN_DEST_ISOLATION_KEYS = ["isolation", "Isolation"] as const;
export const SPAWN_DEST_PATH_KEYS = [
  "worktree_path",
  "worktreePath",
  "worktree",
  "cwd",
  "working_directory",
  "workingDirectory",
  "workdir",
] as const;

const GROK_EXTRA_DEST_KEYS = ["worktree_path", "worktreePath", "worktree"] as const;

/**
 * #4272: `[compat.cursor] hooks = false` is not the product fix. That flag
 * only stops Grok from scanning Cursor hook files; Cursor IDE still loads
 * them. Refuse it because default-on vendor compat must work.
 */
export const GROK_VENDOR_COMPAT_HOOKS_DISABLE_REFUSE =
  "Default-on vendor compat must work; do not set [compat.cursor] hooks = false as the product fix.";

function firstNamedField(source: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = fieldString(source, key);
    if (value !== null) return value;
  }
  return null;
}

export function rerootDestKeyList(): string {
  const isolation = SPAWN_DEST_ISOLATION_KEYS.map((key, index) =>
    index === 0 ? `tool_input.${key}=worktree` : key,
  );
  const names = [...isolation, ...SPAWN_DEST_PATH_KEYS];
  if (names.length === 0) return "";
  if (names.length === 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
}

/**
 * Shared dest-missing imperative for reroot hosts (#4279).
 * Cursor Task overlay strips this sentence (#4362); Claude/Codex keep it.
 */
export function rerootMissingDestImperative(): string {
  return (
    "Pass a destination field inspectSpawnDestination reads (" +
    rerootDestKeyList() +
    ") before the spawn primitive."
  );
}

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
    firstNamedField(toolInput, SPAWN_DEST_ISOLATION_KEYS) ??
    (nested === null ? firstNamedField(input, SPAWN_DEST_ISOLATION_KEYS) : null);
  const pathRaw = firstNamedField(toolInput, SPAWN_DEST_PATH_KEYS);
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

function spawnToolInput(payload: unknown): Record<string, unknown> {
  const input = record(payload);
  if (input === null) return {};
  return toolInputRecord(input) ?? {};
}

function grokExtraDestKey(payload: unknown): string | null {
  const toolInput = spawnToolInput(payload);
  for (const key of GROK_EXTRA_DEST_KEYS) {
    if (fieldPresent(toolInput, key)) return key;
  }
  return null;
}

function grokIsolationWorktree(payload: unknown): boolean {
  const toolInput = spawnToolInput(payload);
  const isolation = fieldString(toolInput, "isolation") ?? fieldString(toolInput, "Isolation");
  return isolation !== null && isolation.toLowerCase() === "worktree";
}

function grokCwdPath(payload: unknown): string | null {
  const cwd = fieldString(spawnToolInput(payload), "cwd");
  return cwd !== null && looksLikePath(cwd) ? cwd : null;
}

function presentedSpawnIncarnation(payload: unknown): string {
  const toolInput = spawnToolInput(payload);
  const fromTool = fieldString(toolInput, "incarnation") ?? fieldString(toolInput, "Incarnation");
  if (fromTool !== null && fromTool.trim().length > 0) return fromTool.trim();
  const input = record(payload);
  if (input === null) return "";
  const fromTop = fieldString(input, "incarnation");
  return fromTop !== null ? fromTop.trim() : "";
}

function leftoverReuseIncarnation(
  existing: ChildOccupancyRecord,
  parentId: string,
  presentedIncarnation: string,
): string | null {
  const existingIncarnation = existing.incarnation.trim();
  if (existingIncarnation.length === 0 || existingIncarnation === "missing") return null;
  if (existing.parentId !== parentId) return null;
  if (presentedIncarnation.length > 0 && presentedIncarnation !== existingIncarnation) {
    return null;
  }
  return existingIncarnation;
}

function grokMissingDestMessage(): string {
  return (
    "Directive denied implement-class spawn: no worktree destination on the spawn payload " +
    "(tool_input.cwd). Spawned mutating work takes its own worktree; do not inherit the " +
    "parent checkout. Grok spawn_subagent cannot rewrite input -- pass cwd to a reserved " +
    "linked worktree before the spawn primitive. " +
    GROK_VENDOR_COMPAT_HOOKS_DISABLE_REFUSE
  );
}

function rerootMissingDestMessage(): string {
  const destKeys = rerootDestKeyList();
  return (
    "Directive denied implement-class spawn: no worktree destination on the spawn payload " +
    "(" +
    destKeys +
    "). Spawned mutating work takes its own worktree; do not inherit the " +
    "parent checkout. " +
    rerootMissingDestImperative() +
    " " +
    SPAWN_CLASS_RECOVERY
  );
}

function isExistingDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function destIsProven(opts: {
  readonly destPath: string | null;
  readonly payloadRoot: string;
  readonly runGit: GitRunner;
}): boolean {
  if (opts.destPath === null) return false;
  if (!isExistingDirectory(opts.destPath)) return false;
  if (!isLinkedWorktreePath(opts.destPath)) return false;
  const destCommon = gitCommonDir(opts.destPath, opts.runGit);
  const parentCommon = gitCommonDir(opts.payloadRoot, opts.runGit);
  if (destCommon === null || parentCommon === null) return false;
  return sameTree(destCommon, parentCommon);
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

export type ConsultImplementSpawnOccupancyInput = {
  readonly payload: unknown;
  readonly payloadRoot: string;
  readonly host: string;
  readonly environ?: NodeJS.ProcessEnv;
  readonly runGit?: GitRunner;
  readonly now?: Date;
  readonly parentId?: string;
};

function consultDeny(
  reason: SpawnOccupancyDenyReason,
  message: string,
  parentId: string,
  destination: SpawnDestination | null = null,
  destPath: string | null = null,
): SpawnOccupancyConsultDeny {
  return {
    allow: false,
    destProven: false,
    reason,
    destination,
    destPath,
    message,
    parentId,
  };
}

function consultCursorNurseryInherit(
  input: ConsultImplementSpawnOccupancyInput,
  payloadRoot: string,
  parentId: string,
  hostCanReroot: boolean,
  runGit: GitRunner,
): SpawnOccupancyConsult | null {
  if (!isLinkedWorktreePath(payloadRoot)) return null;
  if (isMainWorktreePath(payloadRoot, runGit)) return null;
  if (mainWorktreeRoot(payloadRoot, runGit) === null) return null;
  const destination: SpawnDestination = { kind: "path", path: payloadRoot, isolation: null };
  const live = liveOccupant(payloadRoot, input.now);
  if (live !== null && live.sessionId !== parentId) {
    return consultDeny(
      "destination-occupied",
      `Directive denied spawn: destination worktree is occupied by session ${live.sessionId} ` +
        `(intent=${live.intent}). Use another worktree. Do not grant across hosts onto that lease ` +
        "and do not take over the primary checkout.",
      parentId,
      destination,
      payloadRoot,
    );
  }
  const existing = existingDispatchReservation(payloadRoot, payloadRoot);
  if (existing !== null) {
    return consultDeny(
      "reservation-conflict",
      `Directive denied spawn: destination ${payloadRoot} is already reserved for dispatch ` +
        `${existing.incarnation} (agent ${existing.agentId}). Own worktree means a unique ` +
        "reservation, not a shared linked tree.",
      parentId,
      destination,
      payloadRoot,
    );
  }
  const destProven = destIsProven({ destPath: payloadRoot, payloadRoot, runGit });
  return {
    allow: true,
    destProven,
    destination,
    destPath: payloadRoot,
    reRootPath: payloadRoot,
    hostCanReroot,
    message:
      "Directive consulted spawn destination via Cursor nursery inherit. " +
      "Payload root is a non-primary linked worktree; Task dest keys are not used. " +
      `Hook payload window dest is ${payloadRoot}.`,
    parentId,
    leftoverIncarnation: null,
    nurseryInherit: true,
  };
}

/**
 * Decision-only dest occupancy. Does not mint an incarnation or persist a dest-lock.
 */
export function consultImplementSpawnOccupancy(
  input: ConsultImplementSpawnOccupancyInput,
): SpawnOccupancyConsult {
  const payloadRoot = resolve(input.payloadRoot);
  const environ = input.environ ?? process.env;
  const runGit = input.runGit ?? defaultGitRunner;
  const parentId = (input.parentId?.trim() || parentIdFromEnv(environ)).trim() || "none";
  const grokHost = appliesGrokSpawnDestContract({
    host: input.host,
    payload: input.payload,
    environ: input.environ,
  });
  const hostCanReroot = HOSTS_THAT_REROOT.has(input.host) && !grokHost;
  if (isProcessOnlyCriticSpawn(input.payload, { host: input.host, environ: input.environ })) {
    return {
      allow: true,
      destProven: false,
      destination: { kind: "path", path: null, isolation: null },
      destPath: null,
      reRootPath: null,
      hostCanReroot,
      message:
        "Directive skipped dest occupancy consult for process-only critic spawn " +
        "(cwd-without-occupy; subagent_type plan or process_only).",
      parentId,
      leftoverIncarnation: null,
      nurseryInherit: false,
    };
  }
  const grokCwd = grokHost ? grokCwdPath(input.payload) : null;

  if (grokHost) {
    const extra = grokExtraDestKey(input.payload);
    if (extra !== null) {
      return consultDeny(
        "invalid-extra-destination",
        "Directive denied implement-class spawn: extra destination field " +
          `${extra} is invalid on Grok. Grok dest is tool_input.cwd only.`,
        parentId,
      );
    }
    const isolationWorktree = grokIsolationWorktree(input.payload);
    if (isolationWorktree && grokCwd !== null) {
      return consultDeny(
        "invalid-extra-destination",
        "Directive denied implement-class spawn: isolation=worktree together with cwd is " +
          "both-set on Grok. Grok dest is tool_input.cwd only.",
        parentId,
      );
    }
    if (isolationWorktree && grokCwd === null) {
      return consultDeny("destination-missing", grokMissingDestMessage(), parentId);
    }
    if (grokCwd === null) {
      return consultDeny("destination-missing", grokMissingDestMessage(), parentId);
    }
  }

  const destination = grokHost
    ? ({
        kind: "path",
        path: grokCwd,
        isolation: null,
      } satisfies SpawnDestination)
    : inspectSpawnDestination(input.payload);
  if (destination === null || (grokHost && destination.path === null)) {
    if (!grokHost && input.host === "cursor") {
      const nursery = consultCursorNurseryInherit(
        input,
        payloadRoot,
        parentId,
        hostCanReroot,
        runGit,
      );
      if (nursery !== null) return nursery;
    }
    return consultDeny(
      "destination-missing",
      grokHost ? grokMissingDestMessage() : rerootMissingDestMessage(),
      parentId,
    );
  }

  const destPath = resolveDestinationPath(payloadRoot, destination);

  if (destPath === null && !hostCanReroot) {
    return consultDeny(
      "destination-missing",
      grokMissingDestMessage(),
      parentId,
      destination,
      destPath,
    );
  }

  if (grokHost && (destPath === null || !isExistingDirectory(destPath))) {
    return consultDeny(
      "destination-missing",
      "Directive denied implement-class spawn: destination cwd does not exist as a " +
        "directory. Pass cwd to an existing reserved linked worktree.",
      parentId,
      destination,
      destPath,
    );
  }

  if (destPath !== null && isMainWorktreePath(destPath, runGit)) {
    return consultDeny(
      "primary-path",
      "Directive denied implement-class spawn onto the primary checkout. Spawned mutating " +
        "work takes a linked worktree. A spawn payload cannot name a primary-claim exception; " +
        "that exception is occupancy-claim only (release-cut, policy-restore, " +
        "operator-default-branch). " +
        (hostCanReroot
          ? "Pass isolation=worktree or a linked worktree_path."
          : "This host cannot re-root spawn input; pass cwd to a linked worktree."),
      parentId,
      destination,
      destPath,
    );
  }

  if (destPath !== null && existsSync(destPath) && !isLinkedWorktreePath(destPath)) {
    return consultDeny(
      "destination-not-worktree",
      `Directive denied spawn: destination ${destPath} exists and is not a linked worktree. ` +
        "Spawned mutating work takes a linked worktree, not an ordinary directory.",
      parentId,
      destination,
      destPath,
    );
  }

  if (destPath !== null && existsSync(destPath)) {
    const destRepo = mainWorktreeRoot(destPath, runGit);
    const parentRepo = mainWorktreeRoot(payloadRoot, runGit);
    if (destRepo !== null && parentRepo !== null && !sameTree(destRepo, parentRepo)) {
      return consultDeny(
        "destination-foreign",
        `Directive denied spawn: destination ${destPath} is a linked worktree of a foreign repository. ` +
          "Spawned mutating work takes a linked worktree of this repo.",
        parentId,
        destination,
        destPath,
      );
    }
  }

  let leftoverIncarnation: string | null = null;
  if (destPath !== null) {
    const live = liveOccupant(destPath, input.now);
    if (live !== null) {
      return consultDeny(
        "destination-occupied",
        `Directive denied spawn: destination worktree is occupied by session ${live.sessionId} ` +
          `(intent=${live.intent}). Use another worktree. Do not grant across hosts onto that lease ` +
          "and do not take over the primary checkout.",
        parentId,
        destination,
        destPath,
      );
    }
    const existing = existingDispatchReservation(payloadRoot, destPath);
    if (existing !== null) {
      const leftover = leftoverReuseIncarnation(
        existing,
        parentId,
        presentedSpawnIncarnation(input.payload),
      );
      if (leftover === null) {
        return consultDeny(
          "reservation-conflict",
          `Directive denied spawn: destination ${destPath} is already reserved for dispatch ` +
            `${existing.incarnation} (agent ${existing.agentId}). Own worktree means a unique ` +
            "reservation, not a shared linked tree.",
          parentId,
          destination,
          destPath,
        );
      }
      leftoverIncarnation = leftover;
    }
  }

  const destProven = destIsProven({ destPath, payloadRoot, runGit });

  const reRootPath = destPath;
  const rerootNote = hostCanReroot
    ? reRootPath !== null
      ? ` Hook payload will re-root onto ${reRootPath}.`
      : " Host isolation=worktree re-roots the child payload."
    : " This host cannot re-root PreToolUse input; the child must start in the reserved worktree.";
  const leftoverNote =
    leftoverIncarnation !== null
      ? ` Leftover dest-lock incarnation ${leftoverIncarnation} will be released before mint.`
      : "";

  return {
    allow: true,
    destProven,
    destination,
    destPath,
    reRootPath,
    hostCanReroot,
    message: `Directive consulted spawn destination.${leftoverNote}${rerootNote}`,
    parentId,
    leftoverIncarnation,
    nurseryInherit: false,
  };
}

/** Mint incarnation + reservation after remaining parent gates have allowed. */
export function mintImplementSpawnReservation(
  consult: SpawnOccupancyConsultAllow,
  input: ConsultImplementSpawnOccupancyInput,
): SpawnOccupancyAllow {
  const payloadRoot = resolve(input.payloadRoot);
  const incarnation = randomUUID();
  const parentId = consult.parentId;
  const agentId = agentIdFromPayload(input.payload, incarnation);
  const destPath = consult.destPath;
  const reservation: ChildOccupancyDispatchInput = {
    agentId,
    parentId,
    occupancyOwner: parentId,
    worktreePath: destPath ?? join(payloadRoot, ".deft", "spawn-pending", incarnation),
    identitySourceKind: appliesGrokSpawnDestContract({
      host: input.host,
      payload: input.payload,
      environ: input.environ,
    })
      ? "host-env"
      : "payload",
    incarnation,
    provenance: "dispatch",
    nurseryInherit: consult.nurseryInherit,
  };
  const rerootNote = consult.hostCanReroot
    ? consult.reRootPath !== null
      ? ` Hook payload will re-root onto ${consult.reRootPath}.`
      : " Host isolation=worktree re-roots the child payload."
    : " This host cannot re-root PreToolUse input; the child must start in the reserved worktree.";
  return {
    allow: true,
    destination: consult.destination,
    incarnation,
    reservation,
    exemption: null,
    reRootPath: consult.reRootPath,
    hostCanReroot: consult.hostCanReroot,
    message: `Directive reserved spawn worktree incarnation ${incarnation}.${rerootNote}`,
  };
}

export function evaluateImplementSpawnOccupancy(
  input: ConsultImplementSpawnOccupancyInput,
): SpawnOccupancyDecision {
  const consult = consultImplementSpawnOccupancy(input);
  if (!consult.allow) {
    return {
      allow: false,
      reason: consult.reason,
      destination: consult.destination,
      message: consult.message,
    };
  }
  if (isProcessOnlyCriticSpawn(input.payload, { host: input.host, environ: input.environ })) {
    return {
      allow: true,
      destination: consult.destination,
      incarnation: null,
      reservation: null,
      exemption: "process-only-critic",
      reRootPath: null,
      hostCanReroot: consult.hostCanReroot,
      message: consult.message,
    };
  }
  const leftover = consult.leftoverIncarnation?.trim() ?? "";
  if (leftover.length > 0 && consult.destPath !== null) {
    releaseLeftoverSpawnReservation(
      resolve(input.payloadRoot),
      consult.destPath,
      leftover,
      input.now,
    );
  }
  return mintImplementSpawnReservation(consult, input);
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

export type PersistSpawnReservationResult =
  | { ok: true }
  | { ok: false; reason: "conflict" | "occupied" };

/** Persist the dispatch reservation after other spawn gates have allowed. */
export function persistSpawnReservation(
  storeRoot: string,
  reservation: ChildOccupancyDispatchInput,
  now?: Date,
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
        const current = readLockIncarnation(lockRoot, dest);
        if (current !== incarnation) {
          return { ok: false, reason: "conflict" };
        }
      } else {
        throw err;
      }
    }
  }
  const live = existsSync(dest) ? liveOccupant(dest, now) : null;
  if (live !== null) {
    const parentOccupant =
      reservation.nurseryInherit === true &&
      (live.sessionId === reservation.parentId || live.sessionId === reservation.occupancyOwner);
    if (!parentOccupant) {
      if (!skipDestLock) releaseSpawnReservation(root, dest, incarnation);
      return { ok: false, reason: "occupied" };
    }
  }
  recordChildOccupancyLease(root, reservation);
  if (existsSync(dest) && dest !== root) {
    recordChildOccupancyLease(dest, reservation);
  }
  return { ok: true };
}

/**
 * Release a dest-lock leftover of an allow the host did not launch (#4254).
 * Incarnation-scoped, same as releaseSpawnReservation. Refuses when the dest
 * has a live occupant. Also drops matching dispatch occupancy records so a
 * retry is not consult-denied as already reserved. A retry after this returns
 * true may persist a new incarnation.
 */
export function releaseLeftoverSpawnReservation(
  storeRoot: string,
  destPath: string,
  incarnation: string,
  now?: Date,
): boolean {
  const want = incarnation.trim();
  if (want.length === 0) return false;
  const dest = resolve(destPath);
  if (liveOccupant(dest, now) !== null) return false;
  // Revalidate immediately before dest-lock delete so a child that claimed
  // after the first read keeps its dispatch record (#4254 Greptile P1).
  if (liveOccupant(dest, now) !== null) return false;
  const root = resolve(storeRoot);
  const lockRoot = reservationLockRoot(root);
  const releasedLock = releaseSpawnReservation(root, dest, want);
  if (liveOccupant(dest, now) !== null) return false;
  let removedLease = false;
  const roots = [root];
  if (!sameTree(lockRoot, root)) roots.push(lockRoot);
  if (existsSync(dest) && !roots.some((r) => sameTree(r, dest))) roots.push(dest);
  for (const r of roots) {
    if (!existsSync(r)) continue;
    for (const rec of listChildOccupancyLeases(r)) {
      if (rec.provenance !== "dispatch") continue;
      if (rec.incarnation !== want) continue;
      if (!sameTree(rec.worktreePath, dest)) continue;
      if (liveOccupant(dest, now) !== null) return releasedLock || removedLease;
      containedRemove({ root: r, target: join(...childOccupancyRelpath(rec.agentId)) });
      removedLease = true;
    }
  }
  return releasedLock || removedLease;
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

const NURSERY_PARENT_WRITE_DENY =
  "Directive denied parent product writes while a nursery occupancy grant is live on this tree. " +
  "Revoke with occupancy:grant --revoke after the child finishes. Heartbeat, occupancy, and " +
  "forge comments are not this fence.";

function isCursorNurseryDest(destRoot: string, runGit: GitRunner = defaultGitRunner): boolean {
  const dest = resolve(destRoot);
  if (!isLinkedWorktreePath(dest)) return false;
  if (isMainWorktreePath(dest, runGit)) return false;
  return mainWorktreeRoot(dest, runGit) !== null;
}

/** Admit a Cursor nursery child through occupancy:grant; deny parent product writes while live (#4295). */
export function applyCursorNurseryOccupancy(
  destRoot: string,
  gate: OccupancyWriteGateResult,
  sessionId: string,
  now?: Date,
  host?: string,
): OccupancyWriteGateResult {
  const dest = resolve(destRoot);
  const presented = sessionId.trim();
  if (presented.length === 0) return gate;
  if ((host ?? "").trim() !== "cursor") return gate;
  if (!presented.startsWith("host:cursor:")) return gate;
  if (!isCursorNurseryDest(dest)) return gate;
  const at = now ?? new Date();
  if (!gate.allow && gate.occupant !== null && gate.admitted === null) {
    const occupant = gate.occupant;
    if (occupant.sessionId === presented) return gate;
    if (liveOccupancyGrants(occupant, at).length > 0) return gate;
    const existing = existingDispatchReservation(dest, dest);
    if (existing === null || existing.nurseryInherit !== true) return gate;
    if (
      existing.parentId !== occupant.sessionId &&
      existing.occupancyOwner !== occupant.sessionId
    ) {
      return gate;
    }
    const granted = grantOccupancyMembership(dest, {
      sessionId: occupant.sessionId,
      childSessionId: presented,
      role: "leaf-implementation",
      worktreePath: dest,
      now: at,
    });
    if (granted.code !== 0) return gate;
    return evaluateOccupancyWriteGate(dest, { sessionId: presented, now: at });
  }
  if (gate.allow && gate.admitted === "owner") {
    const occupant = gate.occupant;
    if (occupant === null || occupant.sessionId !== presented) return gate;
    if (liveOccupancyGrants(occupant, at).length === 0) return gate;
    const existing = existingDispatchReservation(dest, dest);
    if (existing === null || existing.nurseryInherit !== true) return gate;
    if (existing.parentId !== presented && existing.occupancyOwner !== presented) return gate;
    return {
      allow: false,
      message: NURSERY_PARENT_WRITE_DENY,
      occupant,
      refreshed: false,
      warning: null,
      admitted: null,
      grant: null,
    };
  }
  return gate;
}
