/**
 * Worktree occupancy lease (#3433).
 *
 * Ritual-state is "this session completed ceremony." Occupancy is "who may
 * mutate this tree right now." Those lifetimes differ; do not overload
 * ritual-state.json. Ordinary end is occupancy:release / session:end (#3604).
 *
 * What this boundary is (#3755): a cooperative bearer-id boundary, not a
 * lineage. The lease admits whoever presents an id the record itself names —
 * the occupant's id, or a child id the occupant granted — so possession of a
 * string is the whole credential. Nothing here observes parentage, so a
 * dispatched child is admitted because a grant records it, never because it
 * inherited the holder's rights. Membership is explicit, attributable and
 * expiring (`grantOccupancyMembership`), and it admits writes only: release,
 * steal, heartbeat and cohort close-out stay owner-only, so a grant cannot be
 * spent on the lease itself. Child-initiated join queuing stays out of scope —
 * the owner issues membership; the child does not request it. Ritual state is
 * still single-owner, so a member writes under the occupant's ceremony: the
 * composite hook write gate measures the tree's verified ritual owner against
 * the occupant that issued the grant, not against the writer.
 *
 * Parent and child, answered per identity-source kind (#3954, and it does not
 * have one answer). On a `host-env` host the parent and its dispatched children
 * are different actors, because the host publishes a different id into each
 * agent session. The answer there is identity, not automatic membership: each
 * side resolves its own owner through the shared lookup chain below and claims
 * its own worktree, which is where the dispatch envelope already puts it.
 * Membership stays explicit and owner-issued for the deliberate same-tree case,
 * and it stays affordable only that way -- 32 grants at a four-hour TTL against
 * a twenty-minute lease means granting on every dispatch exhausts a busy
 * parent's lease inside a day. The revocation trigger is therefore the owner's
 * own `occupancy:grant --revoke`, or expiry; releasing a child's lease on its
 * terminal event is dispatcher lifecycle in `child-occupancy.ts` (#3999).
 * On a `payload` host parent and subagents share one id, so there is no foreign
 * child lease to admit and nothing to grant -- and the live consequence is the
 * inverse one: `owns` is true for both, so a parent's `occupancy:release`
 * removes a working child's lease mid-flight with no denial. That is a property
 * of shared host identity, not of this module; a bearer boundary cannot
 * distinguish two processes presenting one string.
 *
 * Concurrency model:
 * - Assumptions: local filesystem; cooperating processes on one machine.
 * - Guarantees: mutual exclusion under crash-free operation; detect-and-abort
 *   if the sidecar lock is compromised (fence before rename/unlink).
 * - Non-goals: network filesystems; Byzantine processes; perfect off-Linux
 *   PID-reuse detection (hard age cap — `OCCUPANCY_MAX_LEASE_MS` — plus fence
 *   instead).
 * - Residual: the write gate authorizes a write it does not itself perform, so
 *   no verdict is atomic with the write. A takeover that publishes after the
 *   allow — including one already holding the lock but not yet written — is
 *   outside what this gate can see. Closing that would mean denying every
 *   owner whose lease file is momentarily locked, which is the load-shedding
 *   regression #3736 fixed. The bound is the TTL, not the gate.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { containedRemove, containedWrite } from "../fs/contained-write.js";
import { assertWriteTargetSafe } from "../fs/projection-containment.js";
import { assertAppendLockOwned, type LockDeps, withAppendLock } from "../slice/lock.js";
import { SWARM_WORKER_ROLES, type SwarmWorkerRole } from "../swarm/routing.js";
import { recordChildOccupancyLease } from "./child-occupancy.js";
import {
  ambientHostSessionOwner,
  claimsHostSessionIdShape,
  parseCanonicalHostSessionId,
} from "./host-session-owner.js";
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
/**
 * Default life of a grant (#3755), sized by one dispatched unit of work:
 * implement, open the PR, run the review cycle. Four hours is a third of the
 * absolute lease cap, so a grant that outlives its child still dies well inside
 * the lease that issued it, and re-granting costs the owner one command.
 */
export const OCCUPANCY_GRANT_TTL_MS = 4 * 60 * 60 * 1000;
/**
 * Grants a single lease may carry (#3755). Bounded because the list is rewritten
 * into the lease file on every touch and the topology it serves is a nuclear
 * family (#3155), not a mesh — a lease needing more than this is a design
 * problem, not a capacity one.
 */
export const OCCUPANCY_MAX_GRANTS = 32;

/**
 * A child admitted to the owner's lease (#3755). The five recorded fields are
 * the point: possession of a session string proves nothing about who is behind
 * it, so admission has to name the owner that issued it, the child it admits,
 * the tree it covers, the role it was dispatched for, and when it stops being
 * true. A grant admits writes; it never admits administration.
 *
 * `worktreePath` is recorded rather than assumed. Dispatched children land in
 * their own worktree because the dispatch envelope puts them there, not because
 * anything enforces it, so same-tree dispatch stays reachable and a lease may
 * hold several grants over one path.
 */
export interface OccupancyGrant {
  readonly ownerSessionId: string;
  readonly childSessionId: string;
  readonly worktreePath: string;
  readonly role: SwarmWorkerRole;
  readonly expiresAt: Date;
  /** Per-actor host of the granted child, mirroring the occupant's own field. */
  readonly host: string;
  /** Per-actor address of the granted child, mirroring the occupant's own field. */
  readonly address: string;
  /** How this child reports back, from the parked join vocabulary. */
  readonly joinProtocol: OccupancyJoinProtocol;
}

/**
 * Who the presented id is to this lease (#3755). `member` is the only thing a
 * grant buys, and it buys it for writes alone.
 */
export type OccupancyAdmission = "owner" | "member" | "stranger";

export interface OccupancyRecord {
  readonly schemaVersion: number;
  readonly sessionId: string;
  readonly worktreePath: string;
  readonly intent: OccupancyIntent;
  readonly claimedAt: Date;
  readonly heartbeatAt: Date;
  /**
   * Last gated product write under this lease — by the owner or by a granted
   * member (#3599 / #3755) — or null when none is recorded. Distinct from
   * `heartbeatAt`, which any lease touch advances.
   * Coarse to `OCCUPANCY_REFRESH_AFTER_MS`: a write inside that floor does not
   * re-stamp, so the recorded time can trail the true last write by up to the
   * refresh interval.
   */
  readonly lastWriteAt: Date | null;
  readonly host: string;
  readonly address: string;
  readonly retainCapable: boolean;
  readonly joinProtocol: OccupancyJoinProtocol;
  /** Children the occupant admitted to this lease for writes (#3755). */
  readonly grants: readonly OccupancyGrant[];
  readonly raw: Record<string, unknown>;
}

export type OccupancyAction =
  | "claimed"
  | "heartbeat"
  | "stolen"
  | "denied"
  | "released"
  | "granted"
  | "revoked";

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
  // The cap is checked first because it is the answer that survives (#3599).
  // A lease can be both, and then the stale reading is actively misleading:
  // it sends the holder to refresh, which a capped lease cannot accept. Order
  // also decides the write gate — the capped-holder refusal below keys on this
  // value, so reading a doubly-dead lease as merely stale would give the more
  // dead lease the more permissive answer.
  if (now.getTime() - record.claimedAt.getTime() > maxLeaseMs) return "age-capped";
  if (now.getTime() - record.heartbeatAt.getTime() > ttlMs) return "heartbeat-stale";
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

/** Grants that still admit somebody (#3755). An expired grant admits nobody. */
export function liveOccupancyGrants(
  record: OccupancyRecord,
  now: Date = new Date(),
): readonly OccupancyGrant[] {
  return record.grants.filter((grant) => grant.expiresAt.getTime() > now.getTime());
}

/**
 * The grant admitting `sessionId`, or null (#3755). Expiry is refused here, on
 * read, rather than trusted to a sweep: nothing guarantees a lease is ever
 * touched again after the grant is written, so a grant that outlived its clock
 * must stop admitting the moment it is read, not the next time it is rewritten.
 */
export function occupancyGrantFor(
  record: OccupancyRecord,
  sessionId: string,
  now: Date = new Date(),
): OccupancyGrant | null {
  const presented = sessionId.trim();
  if (presented.length === 0) return null;
  // The owner holds the lease outright; a grant naming it would add nothing.
  if (presented === record.sessionId) return null;
  return (
    liveOccupancyGrants(record, now).find((grant) => grant.childSessionId === presented) ?? null
  );
}

/**
 * What the presented id is to this lease (#3755). Deliberately not a liveness
 * question: it answers who, and callers pair it with `occupancyLiveness` to
 * answer whether the lease is still worth anything.
 */
export function occupancyAdmission(
  record: OccupancyRecord,
  sessionId: string,
  now: Date = new Date(),
): OccupancyAdmission {
  const presented = sessionId.trim();
  if (presented.length === 0) return "stranger";
  if (presented === record.sessionId) return "owner";
  return occupancyGrantFor(record, presented, now) === null ? "stranger" : "member";
}

// Session ids reach remediation text from operator flags, host environments and
// whatever a peer wrote into the lease, so a value can carry whitespace or shell
// metacharacters. Only a value a shell would take as one bare token is inlined
// into a printed command; anything else keeps its placeholder, because the right
// quoting differs per shell and a mis-parsed copyable command is worse than one
// the reader has to fill in. The id itself is still named in the prose above.
// A leading dash is excluded as well: every CLI parser here reads such a value
// as another option, so `--occupant --weird-id` fails argument parsing even
// though the shell itself would have passed the token through intact.
const SHELL_SAFE_SESSION_ID = /^(?!-)[A-Za-z0-9_.:+=,/-]+$/;

function commandSessionId(sessionId: string, placeholder: string): string {
  return SHELL_SAFE_SESSION_ID.test(sessionId) ? sessionId : placeholder;
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
    `Refresh it with \`deft occupancy:heartbeat --session-id=${commandSessionId(record.sessionId, "<your-session-id>")}\`.`
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
    `\`deft session:start --session-id=${commandSessionId(record.sessionId, "<your-session-id>")}\` before writing again.`
  );
}

/**
 * Tell a refused caller who holds the lease and what it can actually run.
 *
 * `presented` is the id the refused caller offered (#3873). Without it the
 * message can only print `<your-session-id>` placeholders, which is fine for a
 * CLI caller that passed its own `--session-id` and useless to a hook process,
 * which does not know what identity it presented. Passing it also keeps the
 * message honest when there is none: a grant cannot name an empty child --
 * `occupancy:grant --child-session-id=` is refused at parse and at membership --
 * so that remediation is not printed to a caller who could never run it.
 */
export function formatOccupancyRemediation(
  record: OccupancyRecord,
  now: Date = new Date(),
  presented?: string,
): string {
  const age = heartbeatAgeSeconds(record, now);
  const header =
    `Worktree occupied by session ${record.sessionId} (intent=${record.intent}, heartbeat ${age}s ago, ` +
    `${formatLastWritePhrase(record, now)}, ${occupancyClockLine(record)}).\n`;
  const tail = "\nThe occupant may release (`occupancy:release` / `session:end`).";

  if (presented === undefined) {
    return (
      `${header}Stay read-only (\`session:start --read-only\`), use another worktree,\n` +
      "ask the occupant for a write grant (`occupancy:grant --child-session-id=<your-session-id> " +
      "--role <worker-role>`, run by the occupant), or run a confirmed owner transition " +
      `(\`session:start --steal --confirm --occupant <reported-session-id> --session-id=<your-session-id>\`).${tail}`
    );
  }

  const actor = presented.trim();
  const occupantArg = commandSessionId(record.sessionId, "<reported-session-id>");
  if (actor.length === 0) {
    return (
      `${header}This process presented no session identity, so a write grant cannot name it ` +
      "and an owner transition would not be recognised on its next write.\n" +
      "Stay read-only (`session:start --read-only`), use another worktree, or ask the occupant " +
      `to release the lease (\`occupancy:release --session-id=${occupantArg}\` / \`session:end\`).${tail}`
    );
  }
  const actorArg = commandSessionId(actor, "<your-session-id>");
  return (
    `${header}This process presented session ${actor}, which neither holds that lease nor has a ` +
    "write grant on it.\n" +
    "Stay read-only (`session:start --read-only`), use another worktree,\n" +
    `ask the occupant for a write grant (\`occupancy:grant --child-session-id=${actorArg} ` +
    "--role <worker-role>`, run by the occupant), or run a confirmed owner transition " +
    `(\`session:start --steal --confirm --occupant ${occupantArg} --session-id=${actorArg}\`).${tail}`
  );
}

/**
 * Refuse an administrative verb to a granted child (#3755). Named apart from
 * the stranger refusal because the answer differs: this caller is admitted, and
 * telling it to steal or wait would send it to take the very lease its grant
 * derives from. A grant admits writes; the lease has one owner.
 */
export function formatOccupancyMemberAdministrationRefusal(
  record: OccupancyRecord,
  grant: OccupancyGrant,
  verb: string,
): string {
  return (
    `${verb} is owner-only. Session ${grant.childSessionId} holds a write grant on this lease ` +
    `(role=${grant.role}, expires ${timestampIso(grant.expiresAt)}), not the lease itself, and a ` +
    "grant never escalates into administration.\n" +
    `Ask the occupant (session ${record.sessionId}) to run it, or wait for the grant to expire.`
  );
}

/** Which step of the shared lookup chain produced the actor (#3954). */
export type PresentedIdentitySource = "explicit" | "environment" | "host" | "none";

export interface PresentedIdentity {
  /** The id this surface acts under; empty when nothing was presented. */
  readonly sessionId: string;
  readonly source: PresentedIdentitySource;
  /**
   * The owner the running host published, when it names a different session
   * than `sessionId` does; otherwise null. This is the claimer-versus-presenter
   * split itself: the id a session claims under and the id its hook process
   * presents are two different sessions (#3954).
   */
  readonly disagreeingHostOwner: string | null;
}

/**
 * The one lookup order every occupancy surface shares (#3954): an explicit
 * `--session-id`, then `DEFT_SESSION_ID`, then the owner the running host
 * published.
 *
 * The terminal is the caller's, not this function's. Claim mints, because
 * claiming establishes an identity where none exists. Release, heartbeat and
 * grant/revoke are proving one, so they take the empty string and keep the
 * diagnosis written for it -- a shared mint would replace "you presented
 * nothing" with a plausible id no later hook will ever present, on every host
 * that publishes no owner of its own.
 *
 * Disagreement is reported, not resolved. The order stands, so an explicit id
 * beats the environment and the environment beats the host; what changes is
 * that a refused caller is told the host names someone else, which is the state
 * a stale inherited `DEFT_SESSION_ID` produces and the one an operator cannot
 * otherwise see.
 */
export function resolvePresentedIdentity(
  input: { readonly sessionId?: string; readonly env?: NodeJS.ProcessEnv } = {},
): PresentedIdentity {
  const env = input.env ?? process.env;
  const hostOwner = ambientHostSessionOwner(env);
  const disagreement = (chosen: string): string | null =>
    hostOwner !== null && hostOwner !== chosen ? hostOwner : null;
  const explicit = input.sessionId?.trim();
  if (explicit) {
    return {
      sessionId: explicit,
      source: "explicit",
      disagreeingHostOwner: disagreement(explicit),
    };
  }
  const envId = env.DEFT_SESSION_ID?.trim();
  if (envId) {
    return { sessionId: envId, source: "environment", disagreeingHostOwner: disagreement(envId) };
  }
  if (hostOwner !== null) {
    return { sessionId: hostOwner, source: "host", disagreeingHostOwner: null };
  }
  return { sessionId: "", source: "none", disagreeingHostOwner: null };
}

/**
 * Name a claimer-versus-presenter split on a refusal, or return "" (#3954).
 *
 * Appended only to denials: while the caller is admitted the split costs it
 * nothing, and on a refusal it is the one fact that explains why an id the
 * operator believes is theirs is being treated as a stranger's.
 */
export function formatPresentedIdentityDisagreement(identity: PresentedIdentity): string {
  const other = identity.disagreeingHostOwner;
  if (other === null) return "";
  const named =
    identity.source === "explicit" ? "The id passed on the command line" : "DEFT_SESSION_ID";
  return (
    `\n${named} names session ${identity.sessionId}, but this host published ` +
    `${other}. Those are different sessions: re-run with ` +
    `\`--session-id=${commandSessionId(other, "<host-published-id>")}\` to act as the host owner.`
  );
}

/**
 * The owner a claim is made under: the shared lookup chain, then a mint.
 *
 * The host step is what makes an identified host's claim reachable (#3873).
 * Minting instead binds the lease to an id no later hook process can present,
 * so the session that claimed the worktree is refused by its own lease. The
 * mint stays as the last resort for hosts that publish nothing, and it is the
 * one terminal the prove-surfaces deliberately do not share (#3954).
 */
export function resolveOccupancySessionId(input: ApplyOccupancyInput = {}): string {
  const presented = resolvePresentedIdentity(input).sessionId;
  if (presented.length > 0) return presented;
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
      // A granted child reads the member refusal rather than an offer of the
      // write grant it already holds (#3954 item 5): membership admits writes,
      // and claiming the lease stays owner-only.
      message: membershipOwnerDenial(live, incoming, now, "session:start"),
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
          message: membershipOwnerDenial(liveLocked, incoming, now, "session:start"),
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
          // Grants belong to the lease that issued them (#3755): the same owner
          // keeps its members across a heartbeat, and a fresh claim over expired
          // residue starts with none.
          grants: liveLocked === null ? [] : liveOccupancyGrants(liveLocked, now),
        },
        fence,
      );
      const action: OccupancyAction = liveLocked !== null ? "heartbeat" : "claimed";
      if (action === "claimed") {
        maybeRecordChildOccupancyOnClaim(projectRoot, incoming, input.env);
      }
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

/**
 * Stamp the dispatch-recorded child occupancy store at claim time (#3999).
 * Pre-dispatch / worktree mkdir cannot know a host-env child's occupancy
 * owner; the claiming process does. Heartbeat `agent_id` on this host is the
 * raw GROK_SESSION_ID, so that is the store key the terminal monitor looks up.
 */
function maybeRecordChildOccupancyOnClaim(
  projectRoot: string,
  occupancyOwner: string,
  env: NodeJS.ProcessEnv | undefined,
): void {
  const resolved = env ?? process.env;
  const grokRaw = resolved.GROK_SESSION_ID?.trim() ?? "";
  const agentId = grokRaw.length > 0 ? grokRaw : occupancyHost(env);
  if (agentId.length === 0 || agentId === "none") return;
  const parentId = occupancyAddress(env);
  try {
    recordChildOccupancyLease(projectRoot, {
      agentId,
      parentId,
      occupancyOwner,
      worktreePath: resolve(projectRoot),
      identitySourceKind: grokRaw.length > 0 ? "host-env" : "payload",
    });
  } catch {
    // Claim already succeeded; a missing dispatch record is a no-op on terminal.
  }
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
  // A grant admits writes, never the lease itself (#3755). Letting a child steal
  // from the owner that admitted it would turn delegated write access into a
  // path to replace the delegator — the escalation explicit membership exists to
  // remove. Cooperative, like the rest of this file: a caller can present some
  // other id, and then it is a stranger doing a confirmed steal, on the record.
  const stealerGrant = live === null ? null : occupancyGrantFor(live, incoming, now);
  if (live !== null && stealerGrant !== null) {
    return {
      action: "denied",
      sessionId: incoming,
      record: live,
      path,
      message: formatOccupancyMemberAdministrationRefusal(live, stealerGrant, "occupancy:steal"),
      code: 1,
    };
  }
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
      const lockedStealerGrant =
        liveLocked === null ? null : occupancyGrantFor(liveLocked, incoming, now);
      if (liveLocked !== null && lockedStealerGrant !== null) {
        return {
          action: "denied" as const,
          sessionId: incoming,
          record: liveLocked,
          path,
          message: formatOccupancyMemberAdministrationRefusal(
            liveLocked,
            lockedStealerGrant,
            "occupancy:steal",
          ),
          code: 1,
        };
      }
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
          // A steal replaces the owner, and grants are that owner's word about
          // who may write. The new owner never said it, so it does not inherit
          // the members either (#3755).
          grants: [],
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

/**
 * Release the caller's own lease.
 *
 * Owner-only, deliberately (#3954 item 4, answering the open question the
 * design-critique arc left for the builder). Letting an unidentified caller
 * release the occupant the lease file itself records would make possession of
 * that file path into authority to delete a live lease, which is exactly what
 * the `!expired && !owns` refusal exists to prevent -- and the cooperative
 * bearer model (#3755) has no second check behind it. The unreachable printed
 * recovery is fixed by the shared lookup chain instead: on a host that
 * publishes an owner, the occupant now resolves itself and a bare
 * `occupancy:release` is the occupant, so the message the deny prints is one
 * the party it addresses can actually run.
 */
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
  const identity = resolvePresentedIdentity(input);
  const caller = identity.sessionId;
  const split = formatPresentedIdentityDisagreement(identity);
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
          message: membershipOwnerDenial(existing, caller, now, "occupancy:release") + split,
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
          message: membershipOwnerDenial(still, caller, now, "occupancy:release") + split,
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

export interface OccupancyMembershipInput {
  /** The owner issuing or withdrawing the grant; never the child. */
  readonly sessionId?: string;
  readonly childSessionId?: string;
  readonly role?: string;
  readonly worktreePath?: string;
  /** Explicit end of the grant; clamped to the owner's own lease cap. */
  readonly expiresAt?: Date;
  readonly ttlMs?: number;
  readonly host?: string;
  readonly address?: string;
  readonly joinProtocol?: OccupancyJoinProtocol;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: Date;
  readonly lockDeps?: LockDeps;
}

/**
 * Refuse an owner-only verb, saying which of the three the caller is.
 *
 * The caller is passed to `formatOccupancyRemediation` as the presented id
 * (#3954): every one of these surfaces now resolves an actor the caller may not
 * have chosen explicitly, so a refusal that does not name what was presented
 * leaves it guessing which identity it was refused under.
 */
function membershipOwnerDenial(
  live: OccupancyRecord,
  caller: string,
  now: Date,
  verb: string,
): string {
  const grant = occupancyGrantFor(live, caller, now);
  return grant === null
    ? formatOccupancyRemediation(live, now, caller)
    : formatOccupancyMemberAdministrationRefusal(live, grant, verb);
}

/**
 * Admit a dispatched child to this lease for writes (#3755).
 *
 * Owner-only, and the record is the point: a child that writes here is named
 * on the lease it writes under, so an unexpected edit resolves to a session, a
 * role and a tree instead of to "somebody who had the string". The grant cannot
 * outlive the lease that issued it — expiry is clamped to the absolute lease
 * cap — and it buys writes alone.
 */
export function grantOccupancyMembership(
  projectRoot: string,
  input: OccupancyMembershipInput = {},
): OccupancyDecision {
  const now = input.now ?? new Date();
  const path = occupancyPath(projectRoot);
  const identity = resolvePresentedIdentity(input);
  const owner = identity.sessionId;
  const split = formatPresentedIdentityDisagreement(identity);
  const child = input.childSessionId?.trim() ?? "";
  const role = input.role?.trim() ?? "";
  if (owner.length === 0) {
    return {
      action: "denied",
      sessionId: "",
      record: readOccupancy(projectRoot),
      path,
      message:
        "occupancy:grant needs the owner id: pass --session-id <your-session-id> or set " +
        "DEFT_SESSION_ID. Only the occupant may admit a child to its lease.",
      code: 2,
    };
  }
  if (child.length === 0) {
    return {
      action: "denied",
      sessionId: owner,
      record: readOccupancy(projectRoot),
      path,
      message:
        "occupancy:grant needs --child-session-id <session-id>: the id the dispatched child " +
        "will present on its own writes.",
      code: 2,
    };
  }
  if (child === owner) {
    return {
      action: "denied",
      sessionId: owner,
      record: readOccupancy(projectRoot),
      path,
      message:
        "occupancy:grant refuses a self-grant: the lease already admits its owner, so a grant " +
        "naming the same id records nothing and would only blur who wrote what.",
      code: 2,
    };
  }
  // #3954 item 3. A child id under the reserved `host:` prefix must be a
  // well-formed canonical owner: measured, `host:nosuchhost:v9:zzzz` and
  // `host:grok:v1:!!!not-base64url!!!` were granted and then admitted as
  // `member` by the write gate, so the lease read as membership while admitting
  // nobody. An id outside that prefix is still accepted, because a child on a
  // host with no identity contract presents whatever `DEFT_SESSION_ID` holds
  // and refusing that would deny a grant nothing has measured wrong.
  if (claimsHostSessionIdShape(child) && parseCanonicalHostSessionId(child) === null) {
    return {
      action: "denied",
      sessionId: owner,
      record: readOccupancy(projectRoot),
      path,
      message:
        `occupancy:grant refuses the child id ${child}: the \`host:\` prefix is reserved for ` +
        "host-published identity, and this is not a well-formed owner " +
        "(`host:<provider>:v1:<base64url>`), so no session could ever present it. Pass the id " +
        "the child's own host publishes, or an opaque id the child sets as DEFT_SESSION_ID.",
      code: 2,
    };
  }
  // Same defect one step subtler: re-prefixing the owner's own payload under a
  // second provider passes the shape check and is a self-grant in disguise --
  // no session on that other host would present it, and the owner already holds
  // the lease outright.
  const childParts = parseCanonicalHostSessionId(child);
  const ownerParts = parseCanonicalHostSessionId(owner);
  if (
    childParts !== null &&
    ownerParts !== null &&
    childParts.rawSessionId === ownerParts.rawSessionId
  ) {
    return {
      action: "denied",
      sessionId: owner,
      record: readOccupancy(projectRoot),
      path,
      message:
        `occupancy:grant refuses the child id ${child}: it carries this lease owner's own host ` +
        `session (${ownerParts.rawSessionId}) under provider ${childParts.provider}. That is a ` +
        "self-grant across a provider prefix, and the child it names cannot exist.",
      code: 2,
    };
  }
  if (!(SWARM_WORKER_ROLES as readonly string[]).includes(role)) {
    return {
      action: "denied",
      sessionId: owner,
      record: readOccupancy(projectRoot),
      path,
      message:
        `occupancy:grant needs --role from ${SWARM_WORKER_ROLES.join(", ")}. The role is what the ` +
        "grant is for; an unnamed role makes the record unreadable after the fact.",
      code: 2,
    };
  }
  const ttlMs = input.ttlMs ?? OCCUPANCY_GRANT_TTL_MS;
  return withOccupancyLock(
    projectRoot,
    (fence) => {
      const current = readOccupancy(projectRoot);
      const live = current !== null && !isOccupancyExpired(current, now) ? current : null;
      if (live === null) {
        const capped =
          current !== null &&
          current.sessionId === owner &&
          occupancyLiveness(current, now) === "age-capped";
        return {
          action: "denied" as const,
          sessionId: owner,
          record: capped ? current : null,
          path,
          message:
            capped && current !== null
              ? formatOccupancyAgeCapRemediation(current, now)
              : "occupancy:grant found no live lease to grant on. A grant is derived authority, " +
                `so claim the worktree first with \`deft session:start --session-id=${commandSessionId(owner, "<your-session-id>")}\`.`,
          code: 1,
        };
      }
      if (live.sessionId !== owner) {
        return {
          action: "denied" as const,
          sessionId: owner,
          record: live,
          path,
          message: membershipOwnerDenial(live, owner, now, "occupancy:grant") + split,
          code: 1,
        };
      }
      const requested = input.expiresAt ?? new Date(now.getTime() + ttlMs);
      if (requested.getTime() <= now.getTime()) {
        return {
          action: "denied" as const,
          sessionId: owner,
          record: live,
          path,
          message:
            "occupancy:grant refuses an expiry that is already past: a grant that admits nobody " +
            "is indistinguishable from no grant, and recording one would only mislead.",
          code: 2,
        };
      }
      // A grant is derived authority, so it dies with the lease it derives from
      // (#3755). Without this clamp a chain of grants would outlast the absolute
      // cap that keeps a worktree reclaimable.
      const leaseEnds = live.claimedAt.getTime() + OCCUPANCY_MAX_LEASE_MS;
      const expiresAt = requested.getTime() > leaseEnds ? new Date(leaseEnds) : requested;
      const clamped = expiresAt.getTime() !== requested.getTime();
      const kept = liveOccupancyGrants(live, now).filter(
        (existing) => existing.childSessionId !== child,
      );
      if (kept.length >= OCCUPANCY_MAX_GRANTS) {
        return {
          action: "denied" as const,
          sessionId: owner,
          record: live,
          path,
          message:
            `occupancy:grant refuses a ${OCCUPANCY_MAX_GRANTS + 1}th live grant on one lease. ` +
            "Revoke a finished child (`occupancy:grant --revoke --child-session-id=<id>`) or let " +
            "its grant expire.",
          code: 1,
        };
      }
      const grant: OccupancyGrant = {
        ownerSessionId: owner,
        childSessionId: child,
        worktreePath: input.worktreePath?.trim() || live.worktreePath,
        role: role as SwarmWorkerRole,
        expiresAt,
        host: input.host?.trim() || "none",
        address: input.address?.trim() || "none",
        joinProtocol: input.joinProtocol ?? "parent-message",
      };
      const record = writeOccupancyRecord(
        projectRoot,
        {
          sessionId: live.sessionId,
          worktreePath: live.worktreePath,
          intent: live.intent,
          claimedAt: live.claimedAt,
          // Issuing a grant is the owner touching its own lease, which is what
          // heartbeat_at records; claimed_at is untouched, so the cap holds.
          heartbeatAt: now,
          lastWriteAt: live.lastWriteAt,
          host: live.host,
          address: live.address,
          retainCapable: live.retainCapable,
          joinProtocol: live.joinProtocol,
          grants: [...kept, grant],
        },
        fence,
      );
      return {
        action: "granted" as const,
        sessionId: owner,
        record,
        path,
        message:
          `occupancy grant issued to session ${child} (role=${grant.role}, ` +
          `worktree=${grant.worktreePath}, expires ${timestampIso(expiresAt)}` +
          `${clamped ? ", clamped to this lease's absolute age cap" : ""}). ` +
          "It admits writes only; release, steal, heartbeat and cohort close-out stay yours.",
        code: 0,
      };
    },
    input.lockDeps,
  );
}

/**
 * Withdraw a child's grant early (#3755). Expiry already bounds every grant, so
 * this exists for the case expiry cannot serve: the child finished, or should
 * never have been admitted, and the owner wants that true now.
 */
export function revokeOccupancyMembership(
  projectRoot: string,
  input: OccupancyMembershipInput = {},
): OccupancyDecision {
  const now = input.now ?? new Date();
  const path = occupancyPath(projectRoot);
  const identity = resolvePresentedIdentity(input);
  const owner = identity.sessionId;
  const split = formatPresentedIdentityDisagreement(identity);
  // Revoke deliberately skips the grant-time child-id checks: a malformed grant
  // written before those checks existed must stay withdrawable (#3954 item 3).
  const child = input.childSessionId?.trim() ?? "";
  if (owner.length === 0 || child.length === 0) {
    return {
      action: "denied",
      sessionId: owner,
      record: readOccupancy(projectRoot),
      path,
      message:
        "occupancy:grant --revoke needs both the owner id (--session-id or DEFT_SESSION_ID) and " +
        "--child-session-id <session-id>.",
      code: 2,
    };
  }
  return withOccupancyLock(
    projectRoot,
    (fence) => {
      const current = readOccupancy(projectRoot);
      const live = current !== null && !isOccupancyExpired(current, now) ? current : null;
      if (live === null) {
        return {
          action: "revoked" as const,
          sessionId: owner,
          record: null,
          path,
          message:
            "occupancy:grant --revoke found no live lease, so no grant survives it either: " +
            "grants die with the lease that issued them.",
          code: 0,
        };
      }
      if (live.sessionId !== owner) {
        return {
          action: "denied" as const,
          sessionId: owner,
          record: live,
          path,
          message: membershipOwnerDenial(live, owner, now, "occupancy:grant --revoke") + split,
          code: 1,
        };
      }
      const before = liveOccupancyGrants(live, now);
      const remaining = before.filter((existing) => existing.childSessionId !== child);
      if (remaining.length === before.length) {
        return {
          action: "revoked" as const,
          sessionId: owner,
          record: live,
          path,
          message: `occupancy has no live grant for session ${child}; nothing to revoke.`,
          code: 0,
        };
      }
      const record = writeOccupancyRecord(
        projectRoot,
        {
          sessionId: live.sessionId,
          worktreePath: live.worktreePath,
          intent: live.intent,
          claimedAt: live.claimedAt,
          heartbeatAt: now,
          lastWriteAt: live.lastWriteAt,
          host: live.host,
          address: live.address,
          retainCapable: live.retainCapable,
          joinProtocol: live.joinProtocol,
          grants: remaining,
        },
        fence,
      );
      return {
        action: "revoked" as const,
        sessionId: owner,
        record,
        path,
        message: `occupancy grant revoked for session ${child}; its writes are refused from now on.`,
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
  /** Why the write was admitted, or null on a refusal (#3755). */
  readonly admitted: Exclude<OccupancyAdmission, "stranger"> | null;
  /** The grant that admitted a member, or null (#3755). */
  readonly grant: OccupancyGrant | null;
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
  const admission = record === null ? "stranger" : occupancyAdmission(record, incoming, now);
  if (record !== null && liveness === "age-capped" && admission !== "stranger") {
    // Refuse the capped holder rather than warn it (#3599). Its tree is now
    // unheld, so allowing the write would let the very bearer the cap exists to
    // bound keep mutating a worktree a peer may claim between this allow and
    // the write itself. On gated writes the identity comes from the host
    // payload, so the holder cannot present a stranger's id to dodge this.
    //
    // A granted child is refused on the same footing (#3755). Its grant is
    // derived from this lease, so once the lease is gone the grant authorizes
    // writes to a tree nobody holds — the exact bypass the cap exists to close,
    // one hop removed.
    return {
      allow: false,
      message: formatOccupancyAgeCapRemediation(record, now),
      occupant: null,
      refreshed: false,
      warning: null,
      admitted: null,
      grant: null,
    };
  }
  if (record === null || liveness !== "live") {
    return {
      allow: true,
      message: null,
      occupant: null,
      refreshed: false,
      warning: null,
      admitted: null,
      grant: null,
    };
  }
  const live = record;
  if (admission === "stranger") {
    return {
      allow: false,
      // The refused caller is told what identity it actually presented (#3873).
      // A hook process cannot otherwise know, and the grant this message offers
      // is only runnable when the occupant can name a non-empty child.
      message: formatOccupancyRemediation(live, now, incoming),
      occupant: live,
      refreshed: false,
      warning: null,
      admitted: null,
      grant: null,
    };
  }
  if (admission === "member") {
    // A member's write keeps the lease alive (#3755). The lease answers "who may
    // mutate this tree right now", and a tree a granted child is actively
    // writing is in use — letting it lapse would hand the worktree to a peer
    // mid-edit, which is the loss the TTL exists to prevent, not the abandonment
    // it exists to detect. Two bounds still hold: `claimedAt` is untouched, so
    // the absolute age cap is unmoved, and the grant expires on its own clock.
    const memberAgeMs = now.getTime() - live.heartbeatAt.getTime();
    const memberWarning =
      memberAgeMs >= OCCUPANCY_STALE_WARN_MS ? formatOccupancyStaleWarning(live, now) : null;
    if (input.refresh !== true || memberAgeMs < OCCUPANCY_REFRESH_AFTER_MS) {
      return {
        allow: true,
        message: null,
        occupant: live,
        refreshed: false,
        warning: memberWarning,
        admitted: "member",
        grant: occupancyGrantFor(live, incoming, now),
      };
    }
    const memberOutcome = restampOccupancyHeartbeat(
      projectRoot,
      live.sessionId,
      now,
      true,
      input.lockDeps,
      incoming,
    );
    if (memberOutcome.status !== "refreshed") {
      // Same re-decide as the owner path: contention says nothing about who
      // holds the lease now, so ask the file rather than the pre-lock snapshot.
      return evaluateOccupancyWriteGate(projectRoot, { ...input, now, refresh: false });
    }
    return {
      allow: true,
      message: null,
      occupant: memberOutcome.record,
      refreshed: true,
      warning: null,
      admitted: "member",
      grant: occupancyGrantFor(memberOutcome.record, incoming, now),
    };
  }

  const ageMs = now.getTime() - live.heartbeatAt.getTime();
  const warning = ageMs >= OCCUPANCY_STALE_WARN_MS ? formatOccupancyStaleWarning(live, now) : null;
  if (input.refresh !== true || ageMs < OCCUPANCY_REFRESH_AFTER_MS) {
    return {
      allow: true,
      message: null,
      occupant: live,
      refreshed: false,
      warning,
      admitted: "owner",
      grant: null,
    };
  }
  const outcome = restampOccupancyHeartbeat(projectRoot, live.sessionId, now, true, input.lockDeps);
  if (outcome.status !== "refreshed") {
    // Neither failure leaves the pre-lock record usable. `lost` says the lease
    // changed hands outright. `unavailable` says only that the lock could not
    // be taken — but a peer takeover is one of the things that holds it, so a
    // re-stamp that blocks until timeout hides the same handover. Decide
    // against what is on disk now instead of the snapshot read at 598: a lease
    // still ours under contention re-allows exactly as before (#3736), while a
    // replacement owner wins (#3599). Re-entry cannot recurse — refresh is off.
    return evaluateOccupancyWriteGate(projectRoot, { ...input, now, refresh: false });
  }
  return {
    allow: true,
    message: null,
    occupant: outcome.record,
    refreshed: true,
    // `warning` was measured against the pre-refresh heartbeat. Returning it
    // beside a successful re-stamp would tell the owner its lease is going
    // stale on the very write that renewed it.
    warning: null,
    admitted: "owner",
    grant: null,
  };
}

/**
 * Outcome of a re-stamp attempt (#3599). `lost` and `unavailable` are kept
 * apart because they are different facts: the lease is provably not the
 * caller's any more, versus nothing about ownership was observed because the
 * file could not be touched. Collapsing them to one null loses the only
 * evidence a caller has for telling a takeover from a busy lock.
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
 * observed no owner at all, so they are not evidence of replacement. `heartbeat`
 * says so and leaves the lease alone; the write gate re-reads the file rather
 * than trusting either its own stale snapshot or a denial the lock never earned.
 */
function restampOccupancyHeartbeat(
  projectRoot: string,
  sessionId: string,
  now: Date,
  markWrite: boolean,
  lockDeps?: LockDeps,
  /** Refresh on behalf of this granted member rather than the owner (#3755). */
  memberSessionId?: string,
): RestampOutcome {
  try {
    return withOccupancyLock<RestampOutcome>(
      projectRoot,
      (fence) => {
        const current = readOccupancy(projectRoot);
        if (current === null || current.sessionId !== sessionId) return { status: "lost" };
        if (isOccupancyExpired(current, now)) return { status: "lost" };
        // Re-check membership under the lock: the grant read before the wait may
        // have been revoked or expired while it ran (#3755).
        if (
          memberSessionId !== undefined &&
          occupancyGrantFor(current, memberSessionId, now) === null
        ) {
          return { status: "lost" };
        }
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
            // Refresh extends the lease, so it also prunes the grants that died
            // while it ran; expiry is already refused on read (#3755).
            grants: liveOccupancyGrants(current, now),
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
  const identity = resolvePresentedIdentity(input);
  const caller = identity.sessionId;
  const split = formatPresentedIdentityDisagreement(identity);
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
            `\`deft session:start --session-id=${commandSessionId(caller, "<your-session-id>")}\`.`,
      code: 1,
    };
  }
  if (live.sessionId !== caller) {
    return {
      action: "denied",
      sessionId: caller,
      record: live,
      path,
      message: membershipOwnerDenial(live, caller, now, "occupancy:heartbeat") + split,
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

/**
 * Close-out identity comes from the launch manifest, `DEFT_SESSION_ID`, or the
 * owner the running host published — never occupancy.json (#3954).
 *
 * Reading the lease for identity would be the anonymous recorded-occupant
 * release refused in `releaseOccupancy`; the host step is the same shared
 * lookup chain every other occupancy surface uses, so a cohort launched on a
 * host that publishes an owner can close out without an explicit id.
 */
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
  const sessionId = resolvePresentedIdentity({ sessionId: input.sessionId, env }).sessionId;
  if (sessionId.length === 0) {
    const occupant = readOccupancy(projectRoot);
    return {
      action: "denied",
      sessionId: "",
      record: occupant,
      path: occupancyPath(projectRoot),
      message:
        "swarm close-out has no occupancy_session_id (manifest missing or predates the field), " +
        "DEFT_SESSION_ID is unset, and this host published no owner. Re-establish an aligned " +
        "owner with session:start --steal --confirm --occupant <reported-session-id> " +
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
    grants: parseOccupancyGrants(obj.grants, sessionId, worktreePath),
    raw: { ...obj },
  };
}

/**
 * Read the grant list (#3755). A malformed entry is dropped rather than failing
 * the whole record: the lease still has an owner, and losing one grant denies a
 * child a write it can ask for again, while losing the record would strand the
 * tree. Expiry is parsed but not judged here — `occupancyGrantFor` decides that
 * against a clock, so an expired grant stays visible to the owner reading its
 * own lease and is still refused on admission.
 */
function parseOccupancyGrants(
  payload: unknown,
  ownerSessionId: string,
  fallbackWorktree: string,
): readonly OccupancyGrant[] {
  if (!Array.isArray(payload)) return [];
  const grants: OccupancyGrant[] = [];
  for (const entry of payload.slice(0, OCCUPANCY_MAX_GRANTS)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    const childSessionId =
      typeof obj.child_session_id === "string" ? obj.child_session_id.trim() : "";
    if (childSessionId.length === 0) continue;
    const owner = typeof obj.owner_session_id === "string" ? obj.owner_session_id.trim() : "";
    // A grant naming a different owner is residue from a lease that has since
    // changed hands; the current occupant never issued it, so it admits nobody.
    if (owner.length === 0 || owner !== ownerSessionId) continue;
    const expiresAt = parseTimestamp(obj.expires_at);
    if (expiresAt === null) continue;
    const roleRaw = typeof obj.role === "string" ? obj.role : "";
    if (!(SWARM_WORKER_ROLES as readonly string[]).includes(roleRaw)) continue;
    const joinRaw = typeof obj.join_protocol === "string" ? obj.join_protocol : "none";
    grants.push({
      ownerSessionId: owner,
      childSessionId,
      worktreePath:
        typeof obj.worktree_path === "string" && obj.worktree_path.trim().length > 0
          ? obj.worktree_path
          : fallbackWorktree,
      role: roleRaw as SwarmWorkerRole,
      expiresAt,
      host: typeof obj.host === "string" && obj.host.length > 0 ? obj.host : "none",
      address: typeof obj.address === "string" && obj.address.length > 0 ? obj.address : "none",
      joinProtocol: (OCCUPANCY_JOIN_PROTOCOLS as readonly string[]).includes(joinRaw)
        ? (joinRaw as OccupancyJoinProtocol)
        : "none",
    });
  }
  return grants;
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
  readonly grants: readonly OccupancyGrant[];
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
    // Additive (#3755): absent on records written before membership existed,
    // and omitted again when empty so an ungranted lease keeps its old shape.
    ...(record.grants.length === 0
      ? {}
      : { grants: record.grants.map((grant) => occupancyGrantPayload(grant)) }),
  };
}

function occupancyGrantPayload(grant: OccupancyGrant): Record<string, unknown> {
  return {
    owner_session_id: grant.ownerSessionId,
    child_session_id: grant.childSessionId,
    worktree_path: grant.worktreePath,
    role: grant.role,
    expires_at: timestampIso(grant.expiresAt),
    host: grant.host,
    address: grant.address,
    join_protocol: grant.joinProtocol,
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
