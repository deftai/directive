/**
 * Worktree occupancy lease (#3433).
 *
 * Ritual-state is "this session completed ceremony." Occupancy is "who may
 * mutate this tree right now." Those lifetimes differ; do not overload
 * ritual-state.json. Ordinary end is occupancy:release / session:end (#3604).
 * Join negotiation (`occupancy:request`) is out of scope.
 *
 * Concurrency model:
 * - Assumptions: local filesystem; cooperating processes on one machine.
 * - Guarantees: mutual exclusion under crash-free operation; detect-and-abort
 *   if the sidecar lock is compromised (fence before rename/unlink).
 * - Non-goals: network filesystems; Byzantine processes; perfect off-Linux
 *   PID-reuse detection (hard age cap — `OCCUPANCY_MAX_LEASE_MS` — plus fence
 *   instead).
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
/**
 * Owner-allow re-stamp floor (#3599). The write gate runs on every gated write,
 * so refreshing unconditionally would rewrite the lease file per keystroke-scale
 * event. A quarter of the TTL bounds that without shortening the safe window:
 * a write at any age past this floor resets the clock, so an owner that writes
 * at least once per TTL never expires.
 */
export const OCCUPANCY_REFRESH_AFTER_MS = OCCUPANCY_TTL_MS / 4;
/** Owner-allow staleness warning floor: three quarters of the TTL (#3599). */
export const OCCUPANCY_STALE_WARN_MS = (OCCUPANCY_TTL_MS * 3) / 4;
/**
 * Absolute lease age cap, keyed on `claimedAt` and independent of refresh
 * (#3599). Occupancy admits whoever presents the occupant's session id, so
 * "the owner is still writing" only proves that some process holds that
 * string. Without a bound on claim age, refresh would turn the heartbeat TTL —
 * the sole mechanism that reclaims a worktree from a dead session — into
 * something a writer can extend forever.
 *
 * Thirty-six TTLs is twelve hours, sized by the stalled owner rather than the
 * busy one. Refresh keys on writes, so an agent that finishes overnight and
 * waits for its operator is alive, correct, and silent — it stops refreshing
 * while staying entirely legitimate. Twelve hours spans a 23:00 dispatch to a
 * 09:00 handoff and still bounds reclaim well inside a day. Reaching the cap
 * costs the owner one re-claim, not its work.
 *
 * Known limitation: a pure time cap cannot tell a stalled-but-live owner from a
 * dead one, because the only liveness signal on this path is a write. If that
 * ambiguity starts to bite, the answer is a liveness signal that needs no write
 * — an explicit parked state, or refresh on non-write activity — not a larger
 * number here.
 */
export const OCCUPANCY_MAX_LEASE_MS = OCCUPANCY_TTL_MS * 36;
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
  /**
   * Last gated product write by the owner, or null when none is recorded
   * (#3599). Distinct from `heartbeatAt`, which any lease touch advances.
   * Coarse to `OCCUPANCY_REFRESH_AFTER_MS`: a write inside that floor does not
   * re-stamp, so the recorded time can trail the true last write by up to the
   * refresh interval.
   */
  readonly lastWriteAt: Date | null;
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
  /** Record this touch as a product write, not only a heartbeat (#3599). */
  readonly markWrite?: boolean;
  /** When false, evaluate only (including confirmed steal) without writing. */
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

/** Age of the occupant's last recorded product write, or null when none (#3599). */
export function lastWriteAgeSeconds(
  record: OccupancyRecord,
  now: Date = new Date(),
): number | null {
  if (record.lastWriteAt === null) return null;
  return Math.max(0, Math.round((now.getTime() - record.lastWriteAt.getTime()) / 1000));
}

/**
 * Human phrase for how recently the occupant wrote (#3599). Heartbeat age alone
 * cannot distinguish an occupant mid-edit from one that merely claimed and left.
 */
export function formatLastWritePhrase(record: OccupancyRecord, now: Date = new Date()): string {
  const age = lastWriteAgeSeconds(record, now);
  return age === null ? "no recorded write" : `last write ${age}s ago`;
}

/** Age of the lease itself, measured from the claim that opened it (#3599). */
export function leaseAgeSeconds(record: OccupancyRecord, now: Date = new Date()): number {
  return Math.max(0, Math.round((now.getTime() - record.claimedAt.getTime()) / 1000));
}

/**
 * Why a lease is or is not live (#3599). The two dead states are not the same
 * operator problem: `heartbeat-stale` says nobody has touched the lease, while
 * `age-capped` says the holder may well be active but has held the tree past
 * the bound that keeps crash recovery possible.
 */
export type OccupancyLiveness = "live" | "heartbeat-stale" | "age-capped";

export function occupancyLiveness(
  record: OccupancyRecord,
  now: Date = new Date(),
  ttlMs: number = OCCUPANCY_TTL_MS,
  maxLeaseMs: number = OCCUPANCY_MAX_LEASE_MS,
): OccupancyLiveness {
  if (now.getTime() - record.heartbeatAt.getTime() > ttlMs) return "heartbeat-stale";
  if (now.getTime() - record.claimedAt.getTime() > maxLeaseMs) return "age-capped";
  return "live";
}

export function isOccupancyExpired(
  record: OccupancyRecord,
  now: Date = new Date(),
  ttlMs: number = OCCUPANCY_TTL_MS,
  maxLeaseMs: number = OCCUPANCY_MAX_LEASE_MS,
): boolean {
  return occupancyLiveness(record, now, ttlMs, maxLeaseMs) !== "live";
}

function occupancyClockLine(record: OccupancyRecord): string {
  const lastWrite =
    record.lastWriteAt === null ? "" : ` last_write_at=${timestampIso(record.lastWriteAt)}`;
  return `claimed_at=${timestampIso(record.claimedAt)} heartbeat_at=${timestampIso(record.heartbeatAt)}${lastWrite}`;
}

/**
 * Warn the holder that its own lease is inside the staleness window (#3599).
 * Without this the owner learns it went stale only when a peer steals the lease.
 */
export function formatOccupancyStaleWarning(
  record: OccupancyRecord,
  now: Date = new Date(),
  ttlMs: number = OCCUPANCY_TTL_MS,
): string {
  const age = heartbeatAgeSeconds(record, now);
  return (
    `Occupancy lease for session ${record.sessionId} has not beaten for ${age}s of its ` +
    `${Math.round(ttlMs / 1000)}s window; another session may read it as abandoned. ` +
    `Refresh it with \`deft occupancy:heartbeat --session-id=${record.sessionId}\`.`
  );
}

/**
 * Tell the holder its lease aged out of the absolute cap (#3599). Distinct
 * remediation from a stale heartbeat: beating harder cannot help, because the
 * lease is gone rather than merely quiet, so the answer is to re-claim.
 */
export function formatOccupancyAgeCapRemediation(
  record: OccupancyRecord,
  now: Date = new Date(),
  maxLeaseMs: number = OCCUPANCY_MAX_LEASE_MS,
): string {
  const hours = Math.round(maxLeaseMs / (60 * 60 * 1000));
  return (
    `Occupancy lease for session ${record.sessionId} passed its ${hours}h absolute age cap ` +
    `(claimed ${leaseAgeSeconds(record, now)}s ago, ${occupancyClockLine(record)}), so this ` +
    "worktree is no longer held and a peer may claim it at any moment. Heartbeats cannot " +
    "extend a capped lease — re-claim the worktree with " +
    `\`deft session:start --session-id=${record.sessionId}\` before writing again.`
  );
}

export function formatOccupancyRemediation(
  record: OccupancyRecord,
  now: Date = new Date(),
): string {
  const age = heartbeatAgeSeconds(record, now);
  return (
    `Worktree occupied by session ${record.sessionId} (intent=${record.intent}, heartbeat ${age}s ago, ` +
    `${formatLastWritePhrase(record, now)}, ${occupancyClockLine(record)}).\n` +
    "Stay read-only (`session:start --read-only`), use another worktree,\n" +
    "queue a join (`occupancy:request`), or run a confirmed owner transition " +
    "(`session:start --steal --confirm --occupant <reported-session-id> --session-id=<your-session-id>`).\n" +
    "The occupant may release (`occupancy:release` / `session:end`)."
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
  maxLeaseMs: number = OCCUPANCY_MAX_LEASE_MS,
): OccupancyRecord | null {
  const record = readOccupancy(projectRoot);
  if (record === null || isOccupancyExpired(record, now, ttlMs, maxLeaseMs)) return null;
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
          lastWriteAt: input.markWrite === true ? now : (liveLocked?.lastWriteAt ?? null),
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
  const incoming = resolveOccupancySessionId(input);
  if (input.confirm !== true) {
    const current = readOccupancy(projectRoot);
    // Show the occupant's write recency before the steal, not only after it
    // (#3599): heartbeat age alone hides an occupant that is mid-edit.
    const occupantDetail =
      current !== null && !isOccupancyExpired(current, now)
        ? `\n${formatOccupancyRemediation(current, now)}`
        : "";
    return {
      action: "denied",
      sessionId: incoming,
      record: current,
      path,
      message: `occupancy:steal requires --confirm after naming the occupant.${occupantDetail}`,
      code: 2,
    };
  }
  const named = input.occupant?.trim() ?? "";
  if (named.length === 0) {
    return {
      action: "denied",
      sessionId: incoming,
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
      sessionId: incoming,
      record: live,
      path,
      message:
        `occupancy:steal named occupant ${named} does not match live occupant ${live.sessionId}.\n` +
        formatOccupancyRemediation(live, now),
      code: 1,
    };
  }
  if (input.write === false) {
    return {
      action: "stolen",
      sessionId: incoming,
      record: live,
      path,
      message:
        live === null
          ? `occupancy steal preview: writer would be session ${incoming}`
          : `occupancy steal preview: ${live.sessionId} would be replaced by session ${incoming}`,
      code: 0,
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
          sessionId: incoming,
          record: liveLocked,
          path,
          message:
            `occupancy:steal named occupant ${named} does not match live occupant ${liveLocked.sessionId}.\n` +
            formatOccupancyRemediation(liveLocked, now),
          code: 1,
        };
      }
      const priorClock =
        existingLocked !== null
          ? ` (${formatLastWritePhrase(existingLocked, now)}, ${occupancyClockLine(existingLocked)})`
          : "";
      const record = writeOccupancyRecord(
        projectRoot,
        {
          sessionId: incoming,
          worktreePath: resolve(projectRoot),
          intent: input.intent ?? "mutation",
          claimedAt: now,
          heartbeatAt: now,
          lastWriteAt: null,
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
        message:
          `occupancy stolen from ${named}${priorClock}; writer is now session ${record.sessionId}. ` +
          "This command changes the lease only; direct writes remain denied unless ritual state already names the same owner. " +
          "If the owners differ, run `deft session:start --rearm --session-id=<same-session-id>` " +
          "when re-arm is eligible; otherwise run `deft session:start --session-id=<same-session-id>` " +
          "for a cold ceremony, using the writer ID above.",
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

export interface OccupancyWriteGateResult {
  readonly allow: boolean;
  readonly message: string | null;
  readonly occupant: OccupancyRecord | null;
  /** True when this call re-stamped the owner's lease (#3599). */
  readonly refreshed: boolean;
  /** Set when the owner's own lease was inside the staleness window (#3599). */
  readonly warning: string | null;
}

export interface OccupancyWriteGateInput {
  readonly sessionId?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: Date;
  /**
   * Re-stamp the owner's lease on the same-session allow (#3599). Off by
   * default so the gate stays a pure read for callers that only probe; the
   * dispatcher turns it on for the evaluation that immediately precedes an
   * allowed write, so the stamp records a write that actually happened.
   */
  readonly refresh?: boolean;
  readonly lockDeps?: LockDeps;
}

/**
 * Decide whether the presented session may write, and — on the owner-allow
 * path — keep the owner's lease alive (#3599).
 *
 * Before this, the gate was read-only on owner-allow, so the one event that
 * proves the owner is alive did not extend its lease: the live window was
 * twenty minutes from claim, once, regardless of how long the session worked.
 */
export function evaluateOccupancyWriteGate(
  projectRoot: string,
  input: OccupancyWriteGateInput = {},
): OccupancyWriteGateResult {
  const now = input.now ?? new Date();
  const incoming =
    input.sessionId?.trim() || (input.env ?? process.env).DEFT_SESSION_ID?.trim() || "";
  const record = readOccupancy(projectRoot);
  const liveness = record === null ? null : occupancyLiveness(record, now);
  if (record !== null && liveness === "age-capped" && incoming === record.sessionId) {
    // Refuse the capped holder rather than warn it (#3599). Its tree is now
    // unheld, so allowing the write would let the very bearer the cap exists to
    // bound keep mutating a worktree a peer may claim between this allow and
    // the write itself. On gated writes the identity comes from the host
    // payload, so the holder cannot present a stranger's id to dodge this.
    return {
      allow: false,
      message: formatOccupancyAgeCapRemediation(record, now),
      occupant: null,
      refreshed: false,
      warning: null,
    };
  }
  if (record === null || liveness !== "live") {
    return { allow: true, message: null, occupant: null, refreshed: false, warning: null };
  }
  const live = record;
  if (incoming.length === 0 || incoming !== live.sessionId) {
    return {
      allow: false,
      message: formatOccupancyRemediation(live, now),
      occupant: live,
      refreshed: false,
      warning: null,
    };
  }

  const ageMs = now.getTime() - live.heartbeatAt.getTime();
  const warning = ageMs >= OCCUPANCY_STALE_WARN_MS ? formatOccupancyStaleWarning(live, now) : null;
  if (input.refresh !== true || ageMs < OCCUPANCY_REFRESH_AFTER_MS) {
    return { allow: true, message: null, occupant: live, refreshed: false, warning };
  }
  const outcome = restampOccupancyHeartbeat(projectRoot, live.sessionId, now, true, input.lockDeps);
  if (outcome.status === "lost") {
    // The lease died or changed hands between the unlocked read above and the
    // locked re-stamp. Decide against what is on disk now rather than allowing
    // on the stale record we started from: a replacement owner must win, or
    // this gate hands a former owner a write into someone else's worktree
    // (#3599). Re-entry cannot recurse further — refresh is off.
    return evaluateOccupancyWriteGate(projectRoot, { ...input, now, refresh: false });
  }
  return {
    allow: true,
    message: null,
    occupant: outcome.status === "refreshed" ? outcome.record : live,
    refreshed: outcome.status === "refreshed",
    warning,
  };
}

/**
 * Outcome of a re-stamp attempt (#3599). `lost` and `unavailable` are kept
 * apart because they demand opposite answers: the caller no longer holds the
 * lease, versus the caller still holds it but the file could not be touched
 * right now.
 */
type RestampOutcome =
  | { readonly status: "refreshed"; readonly record: OccupancyRecord }
  | { readonly status: "lost" }
  | { readonly status: "unavailable" };

/**
 * Re-stamp an existing live lease held by `sessionId`. Reports `lost` when the
 * lease is gone, expired, or now held by someone else — refresh must never
 * claim or resurrect a lease, only extend one the caller already holds.
 *
 * Lock contention and IO errors report `unavailable` rather than `lost`: they
 * say nothing about who owns the lease, so they must not turn a legitimate
 * owner's write into a denial.
 */
function restampOccupancyHeartbeat(
  projectRoot: string,
  sessionId: string,
  now: Date,
  markWrite: boolean,
  lockDeps?: LockDeps,
): RestampOutcome {
  try {
    return withOccupancyLock<RestampOutcome>(
      projectRoot,
      (fence) => {
        const current = readOccupancy(projectRoot);
        if (current === null || current.sessionId !== sessionId) return { status: "lost" };
        if (isOccupancyExpired(current, now)) return { status: "lost" };
        const record = writeOccupancyRecord(
          projectRoot,
          {
            sessionId: current.sessionId,
            worktreePath: current.worktreePath,
            intent: current.intent,
            claimedAt: current.claimedAt,
            heartbeatAt: now,
            lastWriteAt: markWrite ? now : current.lastWriteAt,
            host: current.host,
            address: current.address,
            retainCapable: current.retainCapable,
            joinProtocol: current.joinProtocol,
          },
          fence,
        );
        return { status: "refreshed", record };
      },
      lockDeps,
    );
  } catch {
    return { status: "unavailable" };
  }
}

/**
 * Refresh the caller's own live lease (#3599). Discoverable counterpart to the
 * automatic write-gate refresh, for sessions whose work is long and quiet:
 * reading, building, or waiting produces no gated write to ride on.
 *
 * Never claims and never mints an owner — an unheld or foreign lease is denied.
 */
export function heartbeatOccupancy(
  projectRoot: string,
  input: ApplyOccupancyInput = {},
): OccupancyDecision {
  const now = input.now ?? new Date();
  const path = occupancyPath(projectRoot);
  const caller =
    input.sessionId?.trim() || (input.env ?? process.env).DEFT_SESSION_ID?.trim() || "";
  if (caller.length === 0) {
    return {
      action: "denied",
      sessionId: "",
      record: readOccupancy(projectRoot),
      path,
      message:
        "occupancy:heartbeat needs the owner id: pass --session-id <your-session-id> or set " +
        "DEFT_SESSION_ID. Refresh extends an existing lease and never mints an owner.",
      code: 2,
    };
  }
  const existing = readOccupancy(projectRoot);
  const live = existing !== null && !isOccupancyExpired(existing, now) ? existing : null;
  if (live === null) {
    const capped =
      existing !== null &&
      existing.sessionId === caller &&
      occupancyLiveness(existing, now) === "age-capped";
    return {
      action: "denied",
      sessionId: caller,
      record: capped ? existing : null,
      path,
      message:
        capped && existing !== null
          ? formatOccupancyAgeCapRemediation(existing, now)
          : "occupancy:heartbeat found no live lease to refresh. Claim one with " +
            `\`deft session:start --session-id=${caller}\`.`,
      code: 1,
    };
  }
  if (live.sessionId !== caller) {
    return {
      action: "denied",
      sessionId: caller,
      record: live,
      path,
      message: formatOccupancyRemediation(live, now),
      code: 1,
    };
  }
  const outcome = restampOccupancyHeartbeat(projectRoot, caller, now, false, input.lockDeps);
  if (outcome.status !== "refreshed") {
    return {
      action: "denied",
      sessionId: caller,
      record: readOccupancy(projectRoot),
      path,
      message:
        outcome.status === "lost"
          ? "occupancy:heartbeat could not refresh the lease: it expired or changed owner " +
            "while the refresh was running."
          : "occupancy:heartbeat could not take the occupancy lock, so the lease is " +
            "unchanged and still yours. Retry in a moment.",
      code: 1,
    };
  }
  const record = outcome.record;
  return {
    action: "heartbeat",
    sessionId: record.sessionId,
    record,
    path,
    message:
      `occupancy heartbeat session ${record.sessionId} (intent=${record.intent}, ` +
      `${occupancyClockLine(record)})`,
    code: 0,
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
        "and DEFT_SESSION_ID is unset. Re-establish an aligned owner with " +
        "session:start --steal --confirm --occupant <reported-session-id> " +
        "--session-id=<your-session-id>.",
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
  // Additive and optional (#3599): records written before the field exists,
  // and by older CLIs, stay readable — absence means "no recorded write".
  const lastWriteAt = parseTimestamp(obj.last_write_at);
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
    lastWriteAt,
    host: typeof obj.host === "string" && obj.host.length > 0 ? obj.host : "none",
    address: typeof obj.address === "string" && obj.address.length > 0 ? obj.address : "none",
    retainCapable: obj.retain_capable === true,
    joinProtocol,
    raw: { ...obj },
  };
}

interface OccupancyWriteFields {
  readonly sessionId: string;
  readonly worktreePath: string;
  readonly intent: OccupancyIntent;
  readonly claimedAt: Date;
  readonly heartbeatAt: Date;
  readonly lastWriteAt: Date | null;
  readonly host: string;
  readonly address: string;
  readonly retainCapable: boolean;
  readonly joinProtocol: OccupancyJoinProtocol;
}

function occupancyPayload(record: OccupancyWriteFields): Record<string, unknown> {
  return {
    schemaVersion: OCCUPANCY_SCHEMA_VERSION,
    session_id: record.sessionId,
    worktree_path: record.worktreePath,
    intent: record.intent,
    claimed_at: timestampIso(record.claimedAt),
    heartbeat_at: timestampIso(record.heartbeatAt),
    ...(record.lastWriteAt === null ? {} : { last_write_at: timestampIso(record.lastWriteAt) }),
    host: record.host,
    address: record.address,
    retain_capable: record.retainCapable,
    join_protocol: record.joinProtocol,
  };
}

function writeOccupancyRecord(
  projectRoot: string,
  record: OccupancyWriteFields,
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
