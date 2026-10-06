/**
 * Disk store for authz state + grants under `.deft/authz/` (#2944).
 */

import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync } from "node:fs";
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
import {
  type AuthzUatWriteDecision,
  type EvaluateAuthzStateWriteOptions,
  evaluateAuthzStateWriteUnderUat,
  evaluateGrantWriteUnderUat,
} from "./uat-write-guard.js";

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
  const wrote = saveGrant(projectRoot, used);
  if (!wrote.ok) return null;
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

/**
 * Rename-away reclaim that refuses to steal a live replacement lock (#4233).
 * After rename, the side file must still match the dead record we inspected;
 * otherwise restore and fail closed so two reclaimers cannot both enter.
 */
function tryReclaimDeadLock(lockPath: string): boolean {
  const existing = readGrantClaimLockRecord(lockPath);
  if (!isGrantClaimLockReclaimable(existing)) return false;
  const expectedPid = existing?.pid ?? null;
  const expectedToken = existing?.token ?? null;
  const side = `${lockPath}.reclaim.${randomBytes(6).toString("hex")}`;
  try {
    renameSync(lockPath, side);
  } catch {
    return false;
  }
  const got = readGrantClaimLockRecord(side);
  const sameDead =
    existing === null
      ? got === null
      : got !== null && got.pid === expectedPid && got.token === expectedToken;
  if (!sameDead) {
    try {
      renameSync(side, lockPath);
    } catch {
      /* best-effort restore of live replacement */
    }
    return false;
  }
  try {
    rmSync(side, { force: true });
  } catch {
    /* best-effort side cleanup */
  }
  return true;
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
   * Order: lock → revalidate → mark single-use usedAt → apply → release lock.
   * If apply throws, usedAt is rolled back (grant reusable) and the lock is released.
   * Concurrent claimants fail closed while the lock is held.
   */
  readonly apply?: (grant: HumanOriginGrant) => void;
}

/**
 * Claim a single-use grant for structural apply (#3239).
 *
 * Concurrent-safe + failure-safe order when `apply` is provided:
 *   exclusive lock → re-load → revalidate → mark single-use usedAt → apply (writes)
 *   → on apply throw: rollback usedAt + release lock (grant reusable for retry).
 * Multi-use grants run apply (if any) without mutating usedAt.
 * Without `apply`, single-use is marked under the lock (claim-only / test path).
 *
 * Crash after mark + before rollback: grant stays spent (no double-apply); operator remints.
 * Dead-PID / corrupt locks reclaim via **rename-away** of the old lock path (only one
 * renamer wins) then exclusive create — never blind rmSync of a live winner's lock.
 * Live PIDs are never reclaimed. PID-reuse residual: operator deletes the lock file.
 */
export function claimSingleUseGrantForApply(
  projectRoot: string,
  grantId: string,
  options: ClaimSingleUseGrantOptions | Date = {},
): { ok: true; grant: HumanOriginGrant } | { ok: false; reason: string } {
  // Back-compat: second arg was `now: Date` in the first #3239 revision.
  const opts: ClaimSingleUseGrantOptions = options instanceof Date ? { now: options } : options;
  const now = opts.now ?? new Date();
  const usedAtIso = utcIso(now);
  const safe = grantId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const root = resolve(projectRoot);
  const lockRel = join(".deft", "authz", "locks", `${safe}.lock`);
  const lockPath = join(root, lockRel);
  const lockToken = randomBytes(8).toString("hex");
  const lockBody = `${JSON.stringify({
    pid: process.pid,
    startedAt: usedAtIso,
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

  /** True when the on-disk lock still carries our token (not stolen mid-section). */
  const stillOwnLock = (): boolean => {
    const rec = readGrantClaimLockRecord(lockPath);
    return rec !== null && rec.token === lockToken && rec.pid === process.pid;
  };

  let locked = tryCreateLock();
  if (!locked) {
    // Dead-PID / corrupt reclaim: rename-away only when side still matches the dead record.
    if (tryReclaimDeadLock(lockPath)) {
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

  let markedUsedAt: string | null = null;
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
    // Spend under lock before protected writes so a post-write mark failure cannot
    // leave completed mutations behind an unspent single-use grant (#3239 Greptile).
    // Apply throw rolls usedAt back while the lock is still held (retry-safe).
    const used: HumanOriginGrant = {
      ...grant,
      semantics: {
        ...grant.semantics,
        usedAt: usedAtIso,
      },
    };
    const spent = saveGrant(projectRoot, used);
    if (!spent.ok) {
      return { ok: false, reason: spent.reason };
    }
    markedUsedAt = usedAtIso;

    if (opts.apply !== undefined) {
      try {
        opts.apply(used);
      } catch (applyErr) {
        // Rollback spend so a failed multi-file apply does not strand the approval.
        const current = loadGrant(projectRoot, grantId);
        if (current?.semantics.singleUse && current.semantics.usedAt === markedUsedAt) {
          const restored: HumanOriginGrant = {
            ...current,
            semantics: { ...current.semantics, usedAt: null },
          };
          saveGrant(projectRoot, restored);
          markedUsedAt = null;
        }
        throw applyErr;
      }
    }

    if (!stillOwnLock()) {
      return {
        ok: false,
        reason:
          `Directive denied scope:decompose apply: grant ${grantId} lock ownership lost mid-claim. ` +
          "Human action required: inspect partial outputs and remint if needed.",
      };
    }
    return { ok: true, grant: used };
  } finally {
    // Only remove the lock when we still own it — never delete a successor's claim.
    if (stillOwnLock()) {
      rmSync(lockPath, { force: true });
    }
  }
}

export type SaveAuthzStateOptions = EvaluateAuthzStateWriteOptions;

/**
 * Persist authz state. Under active UAT, write-class refuse applies (#4233):
 * pin mutate / unsealed campaign-end / other UAT field mutate return ok:false.
 * Sealed campaign-end (CLI after gateConfirm) may flip uat.active true→false only.
 */
function storeWriteFail(
  code: "store-write-lock-timeout" | "store-write-io",
  reason: string,
): AuthzUatWriteDecision {
  return { ok: false, code, reason, intent: "noop" };
}

function withAuthzStoreWriteLock<T>(projectRoot: string, fn: () => T): T | AuthzUatWriteDecision {
  const root = resolve(projectRoot);
  const lockPath = join(root, ".deft", "authz", "locks", "store-write.lock");
  const lockToken = randomBytes(8).toString("hex");
  const lockBody = `${JSON.stringify({
    pid: process.pid,
    startedAt: utcIso(),
    token: lockToken,
  } satisfies GrantClaimLockRecord)}\n`;

  const tryCreateLock = (): boolean | AuthzUatWriteDecision => {
    try {
      containedWrite({ root, target: lockPath, data: lockBody, mode: "create" });
      return true;
    } catch (err) {
      if (err instanceof ContainedWriteError && err.code === "CONTAINED_WRITE_EXISTS") {
        return false;
      }
      const reason = err instanceof Error ? err.message : String(err);
      return storeWriteFail("store-write-io", `authz store lock create failed: ${reason}`);
    }
  };

  const stillOwnLock = (): boolean => {
    const rec = readGrantClaimLockRecord(lockPath);
    return rec !== null && rec.token === lockToken && rec.pid === process.pid;
  };

  const start = Date.now();
  for (;;) {
    const created = tryCreateLock();
    if (created === true) break;
    if (created !== false) return created;
    // Dead-PID / corrupt reclaim — token-checked so a stale reclaim cannot rename a live lock.
    if (tryReclaimDeadLock(lockPath)) {
      const again = tryCreateLock();
      if (again === true) break;
      if (again !== false) return again;
    }
    if (Date.now() - start > 5000) {
      return storeWriteFail(
        "store-write-lock-timeout",
        "authz store write lock timeout (remove leftover `.deft/authz/locks/store-write.lock` after a dead-holder crash if reclaim fails)",
      );
    }
    const waitUntil = Date.now() + 20;
    while (Date.now() < waitUntil) {
      /* spin */
    }
  }
  try {
    return fn();
  } finally {
    // Never delete a successor's claim after reclaim/timeout races.
    if (stillOwnLock()) {
      try {
        unlinkSync(lockPath);
      } catch {
        // ignore
      }
    }
  }
}

export function saveAuthzState(
  projectRoot: string,
  state: AuthzState,
  options: SaveAuthzStateOptions = {},
): AuthzUatWriteDecision {
  return withAuthzStoreWriteLock(projectRoot, () => {
    const prev = loadAuthzState(projectRoot);
    // UAT activate must carry the pin observed under the lock so a pre-lock
    // snapshot cannot drop a concurrent pinned mint (#4233).
    const next: AuthzState =
      prev.uat?.active !== true && state.uat?.active === true
        ? {
            schemaVersion: state.schemaVersion,
            uat: state.uat,
            activeGrantIds: [...prev.activeGrantIds],
          }
        : state;
    const decision = evaluateAuthzStateWriteUnderUat(prev, next, options);
    if (!decision.ok) return decision;
    try {
      writeJsonContained(projectRoot, authzStatePath(projectRoot), next);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return storeWriteFail("store-write-io", `authz state write failed: ${reason}`);
    }
    return decision;
  });
}

/**
 * Load→mutate→evaluate→write authz state under the store write lock (#4233).
 * Callers that only flip UAT must use this so a concurrent pin is not overwritten
 * by a pin snapshot taken before the lock.
 */
export function mutateAuthzState(
  projectRoot: string,
  mutator: (prev: AuthzState) => AuthzState,
  options: SaveAuthzStateOptions = {},
): AuthzUatWriteDecision & { readonly state: AuthzState } {
  const locked = withAuthzStoreWriteLock(projectRoot, () => {
    const prev = loadAuthzState(projectRoot);
    const next = mutator(prev);
    const decision = evaluateAuthzStateWriteUnderUat(prev, next, options);
    if (!decision.ok) {
      return { ...decision, state: prev };
    }
    try {
      writeJsonContained(projectRoot, authzStatePath(projectRoot), next);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        ...storeWriteFail("store-write-io", `authz state write failed: ${reason}`),
        state: prev,
      };
    }
    return { ...decision, state: next };
  });
  if ("state" in locked) return locked;
  return { ...locked, state: loadAuthzState(projectRoot) };
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

/**
 * Persist a grant. Under active UAT (#4233): grant-create and authority-field
 * mutate refuse (returned failure); usedAt-only consume is allowed.
 */
export function saveGrant(projectRoot: string, grant: HumanOriginGrant): AuthzUatWriteDecision {
  return withAuthzStoreWriteLock(projectRoot, () => {
    const state = loadAuthzState(projectRoot);
    const onDisk = loadGrant(projectRoot, grant.id);
    const decision = evaluateGrantWriteUnderUat(state, onDisk, grant);
    if (!decision.ok) return decision;
    try {
      writeJsonContained(projectRoot, authzGrantPath(projectRoot, grant.id), grant);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return storeWriteFail("store-write-io", `authz grant write failed: ${reason}`);
    }
    return decision;
  });
}

/**
 * Persist a minted grant and optionally pin it in one locked transaction (#4233).
 * If the pin write would refuse, the grant file is not written (no orphan active grant).
 * First pin from empty seeds grants that empty-pin currently activates so older
 * still-valid CLI grants keep authorizing outside UAT.
 *
 * Publish order (#4233 residual):
 * - New grant (no on-disk id): pin first, then grant — empty-pin cannot activate an orphan.
 * - Remint (same id on disk): grant first, then pin — interrupt cannot pin old authority.
 * Failures restore the prior pin or prior grant bytes; never unlink a pre-existing same-ID grant.
 */
export function persistMintedGrant(
  projectRoot: string,
  grant: HumanOriginGrant,
  options: { readonly pinActive?: boolean } = {},
): AuthzUatWriteDecision {
  return withAuthzStoreWriteLock(projectRoot, () => {
    const state = loadAuthzState(projectRoot);
    const onDisk = loadGrant(projectRoot, grant.id);
    const grantDecision = evaluateGrantWriteUnderUat(state, onDisk, grant);
    if (!grantDecision.ok) return grantDecision;

    if (options.pinActive !== true) {
      try {
        writeJsonContained(projectRoot, authzGrantPath(projectRoot, grant.id), grant);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return storeWriteFail("store-write-io", `authz grant write failed: ${reason}`);
      }
      return grantDecision;
    }

    const ids = new Set(state.activeGrantIds);
    if (ids.size === 0) {
      for (const active of listActiveHumanGrants(projectRoot, state)) {
        ids.add(active.id);
      }
    }
    ids.add(grant.id);
    const nextState: AuthzState = {
      schemaVersion: 1,
      uat: state.uat,
      activeGrantIds: [...ids],
    };
    const pinDecision = evaluateAuthzStateWriteUnderUat(state, nextState);
    if (!pinDecision.ok) return pinDecision;

    const grantPath = authzGrantPath(projectRoot, grant.id);
    const statePath = authzStatePath(projectRoot);

    if (onDisk === null) {
      // New mint: pin before grant so empty-pin cannot activate a half-written grant.
      try {
        writeJsonContained(projectRoot, statePath, nextState);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return storeWriteFail("store-write-io", `authz pin write failed: ${reason}`);
      }
      try {
        writeJsonContained(projectRoot, grantPath, grant);
      } catch (err) {
        try {
          writeJsonContained(projectRoot, statePath, state);
        } catch {
          /* best-effort pin restore */
        }
        const reason = err instanceof Error ? err.message : String(err);
        return storeWriteFail("store-write-io", `authz grant write failed after pin: ${reason}`);
      }
    } else {
      // Remint: replace grant bytes first so an interrupt cannot leave old authority pinned.
      // Containment/IO refuse before publish must not unlink the prior same-ID path.
      try {
        writeJsonContained(projectRoot, grantPath, grant);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return storeWriteFail("store-write-io", `authz remint grant write failed: ${reason}`);
      }
      try {
        writeJsonContained(projectRoot, statePath, nextState);
      } catch (err) {
        try {
          writeJsonContained(projectRoot, grantPath, onDisk);
        } catch {
          /* best-effort grant restore */
        }
        const reason = err instanceof Error ? err.message : String(err);
        return storeWriteFail("store-write-io", `authz pin write failed after grant: ${reason}`);
      }
    }
    return pinDecision;
  });
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
 *
 * Empty pin (#4233): outside UAT activates all non-revoked human-origin grants;
 * under active UAT activates none (fail closed). startUatLease carries the pin forward.
 */
export function listActiveHumanGrants(
  projectRoot: string,
  state: AuthzState = loadAuthzState(projectRoot),
  now: Date = new Date(),
): HumanOriginGrant[] {
  const all = listGrants(projectRoot);
  const pin = state.activeGrantIds;
  const uatActive = state.uat?.active === true;
  // Outside UAT: empty pin = no filter. Under UAT: empty pin = activate none.
  const pinSet = pin.length > 0 ? new Set(pin) : uatActive ? new Set<string>() : null;
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
