/**
 * Disk store for authz state + grants under `.deft/authz/` (#2944).
 */

import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { ContainedWriteError, containedWrite } from "../fs/contained-write.js";
import { assertWriteTargetSafe } from "../fs/projection-containment.js";
import { isHumanOrigin } from "./origin.js";
import { authzAuditPath, authzGrantPath, authzGrantsDir, authzStatePath } from "./paths.js";
import {
  AUTHZ_OPERATIONS,
  type AuthzAuditRecord,
  type AuthzOperation,
  type AuthzState,
  type GrantOrigin,
  type GrantScope,
  type GrantSemantics,
  type HumanOriginGrant,
  type UatLease,
} from "./types.js";

function utcIso(now?: Date): string {
  const dt = now ?? new Date();
  return dt.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Contained atomic JSON write for authz state/grants (#2980 / Greptile P1).
 * Containment root is projectRoot (not dirname(target)) so parent-symlink escape fails closed.
 * Unique random temp names avoid PID-reuse collisions; rename is the atomic publish step.
 */
function writeJsonContained(projectRoot: string, targetPath: string, payload: unknown): void {
  const root = resolve(projectRoot);
  const abs = resolve(targetPath);
  // Refuse leaf/parent symlinks on the final path before temp+rename publish.
  assertWriteTargetSafe(root, abs);
  const dir = dirname(abs);
  const tmpBase = `.${basename(abs)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const tmp = join(dir, tmpBase);
  try {
    containedWrite({
      root,
      target: tmp,
      data: `${JSON.stringify(payload, null, 2)}\n`,
      mode: "create",
    });
    renameSync(tmp, abs);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

function readString(rec: Record<string, unknown>, key: string): string | null {
  const v = rec[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function readStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}

function readNumberArray(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
}

function parseOrigin(raw: unknown): GrantOrigin | null {
  const rec = record(raw);
  if (rec === null) return null;
  const kind = readString(rec, "kind");
  const actor = readString(rec, "actor");
  const mintedAt = readString(rec, "mintedAt") ?? readString(rec, "minted_at");
  const mintedVia = readString(rec, "mintedVia") ?? readString(rec, "minted_via") ?? "unknown";
  if (kind === null || actor === null || mintedAt === null) return null;
  const eventRef = readString(rec, "eventRef") ?? readString(rec, "event_ref");
  return { kind, actor, mintedAt, mintedVia, eventRef };
}

function parseOperations(raw: unknown): AuthzOperation[] {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set<string>(AUTHZ_OPERATIONS);
  const out: AuthzOperation[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const op = item.trim().toLowerCase();
    if (allowed.has(op)) out.push(op as AuthzOperation);
  }
  return out;
}

function parseScope(raw: unknown): GrantScope | null {
  const rec = record(raw);
  if (rec === null) return null;
  return {
    planRef:
      readString(rec, "planRef") ?? readString(rec, "plan_ref") ?? readString(rec, "planHash"),
    repo: readString(rec, "repo"),
    branch: readString(rec, "branch"),
    worktree: readString(rec, "worktree"),
    surfaces: readStringArray(rec.surfaces),
    operations: parseOperations(rec.operations),
    storyIds: readStringArray(rec.storyIds ?? rec.story_ids),
    issueIds: readNumberArray(rec.issueIds ?? rec.issue_ids),
    cohortId: readString(rec, "cohortId") ?? readString(rec, "cohort_id"),
    // #3239 structural decompose apply bindings (snake_case accepted on load).
    contentDigest:
      readString(rec, "contentDigest") ??
      readString(rec, "content_digest") ??
      readString(rec, "draftDigest") ??
      readString(rec, "draft_digest"),
    parentPath: readString(rec, "parentPath") ?? readString(rec, "parent_path"),
    targetPath: readString(rec, "targetPath") ?? readString(rec, "target_path"),
  };
}

function parseSemantics(raw: unknown): GrantSemantics {
  const rec = record(raw);
  if (rec === null) {
    return { expiresAt: null, singleUse: false, usedAt: null, revokedAt: null };
  }
  return {
    expiresAt: readString(rec, "expiresAt") ?? readString(rec, "expires_at"),
    singleUse: rec.singleUse === true || rec.single_use === true,
    usedAt: readString(rec, "usedAt") ?? readString(rec, "used_at"),
    revokedAt: readString(rec, "revokedAt") ?? readString(rec, "revoked_at"),
  };
}

/** Parse a grant JSON object; returns null when structurally unusable. */
export function parseGrant(raw: unknown): HumanOriginGrant | null {
  const rec = record(raw);
  if (rec === null) return null;
  const id = readString(rec, "id");
  const origin = parseOrigin(rec.origin);
  const scope = parseScope(rec.scope);
  if (id === null || origin === null || scope === null) return null;
  return {
    schemaVersion: 1,
    id,
    origin,
    scope,
    semantics: parseSemantics(rec.semantics),
  };
}

export function parseUatLease(raw: unknown): UatLease | null {
  const rec = record(raw);
  if (rec === null) return null;
  const campaignId = readString(rec, "campaignId") ?? readString(rec, "campaign_id");
  const startedAt = readString(rec, "startedAt") ?? readString(rec, "started_at");
  const startedBy = parseOrigin(rec.startedBy ?? rec.started_by);
  if (campaignId === null || startedAt === null || startedBy === null) return null;
  const active = rec.active === true;
  return {
    active,
    campaignId,
    startedAt,
    startedBy,
    suspendedAt: readString(rec, "suspendedAt") ?? readString(rec, "suspended_at"),
    note: readString(rec, "note"),
  };
}

export function parseAuthzState(raw: unknown): AuthzState {
  const rec = record(raw);
  if (rec === null) {
    return { schemaVersion: 1, uat: null, activeGrantIds: [] };
  }
  const uat = "uat" in rec ? parseUatLease(rec.uat) : null;
  return {
    schemaVersion: 1,
    uat,
    activeGrantIds: readStringArray(rec.activeGrantIds ?? rec.active_grant_ids),
  };
}

/**
 * Load result distinguishes missing state (inactive) from corrupt state
 * (fail-closed deny-all under UAT posture — #2944 Greptile/SLizard).
 */
export type AuthzStateLoad =
  | { readonly ok: true; readonly state: AuthzState; readonly corrupt: false }
  | {
      readonly ok: false;
      readonly state: AuthzState;
      readonly corrupt: true;
      readonly reason: string;
    };

/** Synthetic fail-closed state: active UAT with no human origin (evaluate treats corrupt separately). */
function corruptFailClosedState(): AuthzState {
  return {
    schemaVersion: 1,
    uat: {
      active: true,
      campaignId: "__corrupt_authz_state__",
      startedAt: "1970-01-01T00:00:00Z",
      startedBy: {
        kind: "operator-cli",
        actor: "system",
        mintedAt: "1970-01-01T00:00:00Z",
        mintedVia: "corrupt-state-fail-closed",
        eventRef: null,
      },
      suspendedAt: null,
      note: "authz state unreadable — fail closed",
    },
    activeGrantIds: [],
  };
}

export function loadAuthzStateResult(projectRoot: string): AuthzStateLoad {
  const path = authzStatePath(projectRoot);
  if (!existsSync(path)) {
    return {
      ok: true,
      corrupt: false,
      state: { schemaVersion: 1, uat: null, activeGrantIds: [] },
    };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return { ok: true, corrupt: false, state: parseAuthzState(raw) };
  } catch (err) {
    return {
      ok: false,
      corrupt: true,
      reason: `authz state unreadable at ${path}: ${String(err)}`,
      state: corruptFailClosedState(),
    };
  }
}

export function loadAuthzState(projectRoot: string): AuthzState {
  return loadAuthzStateResult(projectRoot).state;
}

/** Persist single-use grant consumption after an allow decision (#2944). */
export function markGrantUsed(
  projectRoot: string,
  grantId: string,
  now: Date = new Date(),
): HumanOriginGrant | null {
  const grant = loadGrant(projectRoot, grantId);
  if (grant === null) return null;
  if (!grant.semantics.singleUse) return grant;
  if (grant.semantics.usedAt !== null) return grant;
  const used: HumanOriginGrant = {
    ...grant,
    semantics: {
      ...grant.semantics,
      usedAt: utcIso(now),
    },
  };
  saveGrant(projectRoot, used);
  return used;
}

/** Exclusive claim lock body under `.deft/authz/locks/<id>.lock` (#3239). */
export interface GrantClaimLockRecord {
  readonly pid: number;
  readonly startedAt: string;
  readonly token: string;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ESRCH → dead. EPERM → exists but unsignalable — treat as alive (never reclaim).
    if (code === "EPERM") return true;
    return false;
  }
}

/**
 * Whether a claim lock may be reclaimed after a crashed holder (#3239).
 * Live owner PIDs are never reclaimed (no mtime-only steal of a live critical section).
 * Corrupt / unreadable records are reclaimable; PID-reuse residual needs manual delete.
 */
export function isGrantClaimLockReclaimable(rec: GrantClaimLockRecord | null): boolean {
  if (rec === null) return true;
  return !isProcessAlive(rec.pid);
}

function readGrantClaimLockRecord(lockPath: string): GrantClaimLockRecord | null {
  try {
    const raw = readFileSync(lockPath, "utf8").trim();
    // JSON form (current). Legacy: "pid\niso\n" lines from earlier #3239 revisions.
    if (raw.startsWith("{")) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const o = parsed as Record<string, unknown>;
      const pid = typeof o.pid === "number" ? o.pid : Number(o.pid);
      const startedAt = typeof o.startedAt === "string" ? o.startedAt : "";
      const token = typeof o.token === "string" ? o.token : "";
      if (!Number.isFinite(pid) || token.length === 0) return null;
      return { pid, startedAt, token };
    }
    const lines = raw.split(/\r?\n/);
    const pid = Number(lines[0]);
    if (!Number.isFinite(pid)) return null;
    return {
      pid,
      startedAt: typeof lines[1] === "string" ? lines[1] : "",
      token: "legacy",
    };
  } catch {
    return null;
  }
}

export interface ClaimSingleUseGrantOptions {
  readonly now?: Date;
  /**
   * Re-check grant after exclusive lock (revocation/expiry/origin/bindings).
   * Called before protected apply / single-use mark so an invalidated grant cannot authorize writes.
   */
  readonly revalidate?: (grant: HumanOriginGrant) => { ok: true } | { ok: false; reason: string };
  /**
   * Protected work under the exclusive claim (#3239 residual).
   * Order: lock → revalidate → apply → mark single-use usedAt → release lock.
   * If apply throws, usedAt is not set (grant reusable) and the lock is released.
   * Concurrent claimants fail closed while the lock is held.
   */
  readonly apply?: (grant: HumanOriginGrant) => void;
}

/**
 * Claim a single-use grant for structural apply (#3239).
 *
 * Concurrent-safe + failure-safe order when `apply` is provided:
 *   exclusive lock → re-load → revalidate → apply (writes) → mark usedAt → release lock.
 * Multi-use grants run apply (if any) without mutating usedAt.
 * Without `apply`, single-use is marked under the lock immediately (claim-only / test path).
 *
 * Crash recovery: lock files hold pid+token. Dead-PID (or corrupt) locks are reclaimable
 * via exclusive recreate (only one winner). Live PIDs are never reclaimed — no mtime-only
 * steal of a live critical section. PID-reuse residual: operator deletes the lock file.
 */
export function claimSingleUseGrantForApply(
  projectRoot: string,
  grantId: string,
  options: ClaimSingleUseGrantOptions | Date = {},
): { ok: true; grant: HumanOriginGrant } | { ok: false; reason: string } {
  // Back-compat: second arg was `now: Date` in the first #3239 revision.
  const opts: ClaimSingleUseGrantOptions = options instanceof Date ? { now: options } : options;
  const now = opts.now ?? new Date();
  const safe = grantId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const root = resolve(projectRoot);
  const lockRel = join(".deft", "authz", "locks", `${safe}.lock`);
  const lockPath = join(root, lockRel);
  const lockToken = randomBytes(8).toString("hex");
  const lockBody = `${JSON.stringify({
    pid: process.pid,
    startedAt: utcIso(now),
    token: lockToken,
  } satisfies GrantClaimLockRecord)}\n`;

  const tryCreateLock = (): boolean => {
    try {
      containedWrite({
        root,
        target: lockPath,
        data: lockBody,
        mode: "create",
      });
      return true;
    } catch (err) {
      if (err instanceof ContainedWriteError && err.code === "CONTAINED_WRITE_EXISTS") {
        return false;
      }
      // Other containment/IO failures fail closed as reservation denial.
      return false;
    }
  };

  let locked = tryCreateLock();
  if (!locked) {
    // Dead-PID / corrupt lock reclaim: delete only when reclaimable, then one exclusive retry.
    // Two reclaimers may both delete; only one create-exclusive succeeds (#3239).
    const existing = readGrantClaimLockRecord(lockPath);
    if (isGrantClaimLockReclaimable(existing)) {
      try {
        rmSync(lockPath, { force: true });
      } catch {
        /* best-effort */
      }
      locked = tryCreateLock();
    }
  }
  if (!locked) {
    return {
      ok: false,
      reason:
        `Directive denied scope:decompose apply: grant ${grantId} is already reserved ` +
        "or spent by a concurrent apply. Human action required: remint if the prior apply failed " +
        "(or remove a leftover `.deft/authz/locks/<id>.lock` after a dead-holder crash if reclaim fails).",
    };
  }

  try {
    const grant = loadGrant(projectRoot, grantId);
    if (grant === null) {
      return {
        ok: false,
        reason: `Directive denied scope:decompose apply: grant ${grantId} missing.`,
      };
    }
    if (opts.revalidate !== undefined) {
      const check = opts.revalidate(grant);
      if (!check.ok) {
        return { ok: false, reason: check.reason };
      }
    }
    if (!grant.semantics.singleUse) {
      if (opts.apply !== undefined) {
        opts.apply(grant);
      }
      return { ok: true, grant };
    }
    if (grant.semantics.usedAt !== null) {
      return {
        ok: false,
        reason:
          `Directive denied scope:decompose apply: single-use grant ${grantId} already spent at ` +
          `${grant.semantics.usedAt}.`,
      };
    }
    // Transactional path: run protected writes before spending the grant.
    if (opts.apply !== undefined) {
      opts.apply(grant);
    }
    const used: HumanOriginGrant = {
      ...grant,
      semantics: {
        ...grant.semantics,
        usedAt: utcIso(now),
      },
    };
    saveGrant(projectRoot, used);
    return { ok: true, grant: used };
  } finally {
    // Only the owner removes its lock; force so a partial crash mid-claim still cleans up
    // when the process is still alive to run finally. Dead-process leftovers use reclaim.
    rmSync(lockPath, { force: true });
  }
}

export function saveAuthzState(projectRoot: string, state: AuthzState): void {
  writeJsonContained(projectRoot, authzStatePath(projectRoot), state);
}

export function loadGrant(projectRoot: string, grantId: string): HumanOriginGrant | null {
  const path = authzGrantPath(projectRoot, grantId);
  if (!existsSync(path)) return null;
  try {
    return parseGrant(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return null;
  }
}

export function saveGrant(projectRoot: string, grant: HumanOriginGrant): void {
  writeJsonContained(projectRoot, authzGrantPath(projectRoot, grant.id), grant);
}

export function listGrants(projectRoot: string): HumanOriginGrant[] {
  const dir = authzGrantsDir(projectRoot);
  if (!existsSync(dir)) return [];
  const out: HumanOriginGrant[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const grant = parseGrant(JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown);
      if (grant !== null) out.push(grant);
    } catch {
      // skip corrupt grant files
    }
  }
  return out;
}

/**
 * Active grants: non-revoked, optionally filtered by state.activeGrantIds,
 * human-origin only (self-authored records stay on disk but do not activate).
 */
export function listActiveHumanGrants(
  projectRoot: string,
  state: AuthzState = loadAuthzState(projectRoot),
  now: Date = new Date(),
): HumanOriginGrant[] {
  const all = listGrants(projectRoot);
  const pin = state.activeGrantIds;
  const pinSet = pin.length > 0 ? new Set(pin) : null;
  const nowMs = now.getTime();
  return all.filter((g) => {
    if (pinSet !== null && !pinSet.has(g.id)) return false;
    if (g.semantics.revokedAt !== null) return false;
    if (g.semantics.singleUse && g.semantics.usedAt !== null) return false;
    if (g.semantics.expiresAt !== null) {
      const exp = Date.parse(g.semantics.expiresAt);
      if (!Number.isNaN(exp) && exp <= nowMs) return false;
    }
    return isHumanOrigin(g.origin);
  });
}

export function appendAuthzAudit(projectRoot: string, record: AuthzAuditRecord): void {
  const root = resolve(projectRoot);
  const path = authzAuditPath(projectRoot);
  // #2980 wave B: product write sink routes through containedWrite.
  containedWrite({
    root,
    target: path,
    data: `${JSON.stringify(record)}\n`,
    mode: "append",
  });
}

export function mintOperatorOrigin(
  actor: string,
  mintedVia: string,
  now?: Date,
  eventRef: string | null = null,
): GrantOrigin {
  return {
    kind: "operator-cli",
    actor: actor.trim().length > 0 ? actor.trim() : "operator",
    mintedAt: utcIso(now),
    mintedVia,
    eventRef,
  };
}

export { utcIso };
