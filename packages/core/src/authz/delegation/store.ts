/**
 * Protected delegation store (#7420 B1 / B2).
 *
 * Lives at `<main checkout>/.deft/authz/delegation/` so a linked worktree and
 * the primary see one record. Every arm and every end runs in one locked step
 * (exclusive-create lock file), so `lastAcceptedStep` and the record are read
 * and written together.
 *
 * Liveness is evaluated at each use, never cached: the record must not be
 * ended, must not be past `expiresAt`, no UAT lease may be active, and no kill
 * record may be present. `delegate off`, session end, UAT start, the kill
 * switch and a terminal `authz:revoke` end it explicitly; TTL ends it lazily.
 */

import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  ContainedWriteError,
  containedChmod,
  containedRemove,
  containedWrite,
} from "../../fs/contained-write.js";
import { assertWriteTargetSafe } from "../../fs/projection-containment.js";
import { killSwitchRecordPath } from "../../policy/kill-switch-record.js";
import type { GitRunner } from "../../session/git.js";
import { mainWorktreeRoot } from "../../session/main-worktree.js";
import { loadAuthzStateResult } from "../store.js";
import {
  DELEGABLE_APPROVED_SCOPE_VERB,
  DELEGABLE_GRANT_VERB,
  DELEGABLE_HOOK_ALLOWS,
  DELEGABLE_MINT_VERBS,
  DELEGABLE_RELEASE_TEMPLATES,
  DELEGATED_ACTION_CHAT_LINE_PREFIX,
  DELEGATED_TOTP_PROVENANCE,
  DELEGATION_AUDIT_FILE,
  DELEGATION_LOCK_FILE,
  DELEGATION_LOCK_RETRY_MS,
  DELEGATION_LOCK_TIMEOUT_MS,
  DELEGATION_MAX_TTL_HOURS,
  DELEGATION_SCHEMA_VERSION,
  DELEGATION_SECRET_DIR_NAME,
  DELEGATION_SECRET_FILE_NAME,
  DELEGATION_STATE_FILE,
  DELEGATION_STORE_REL,
  type DelegatedCompletion,
  type DelegationAuditRecord,
  type DelegationEndReason,
  type DelegationLiveness,
  type DelegationRecord,
  type DelegationState,
  type LiveDelegationView,
} from "./types.js";

const MS_PER_HOUR = 3600 * 1000;

export function utcIsoSeconds(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Store root: the main checkout of `projectRoot` (git common dir parent), so
 * every linked worktree reads the same record. Outside git: `projectRoot`.
 */
export function resolveDelegationStoreRoot(projectRoot: string, runGit?: GitRunner): string {
  const main =
    runGit === undefined ? mainWorktreeRoot(projectRoot) : mainWorktreeRoot(projectRoot, runGit);
  return main ?? resolve(projectRoot);
}

export function delegationDir(storeRoot: string): string {
  return join(resolve(storeRoot), ...DELEGATION_STORE_REL.split("/"));
}

export function delegationStatePath(storeRoot: string): string {
  return join(delegationDir(storeRoot), DELEGATION_STATE_FILE);
}

export function delegationAuditPath(storeRoot: string): string {
  return join(delegationDir(storeRoot), DELEGATION_AUDIT_FILE);
}

export function delegationLockPath(storeRoot: string): string {
  return join(delegationDir(storeRoot), DELEGATION_LOCK_FILE);
}

/**
 * Enrolled secret path, outside every repository. No env override exists on
 * purpose: an override would let an agent shell point arming at a secret it
 * wrote itself. Tests inject the path through the arm/enroll seams instead.
 */
export function resolveDelegationSecretPath(
  input: {
    readonly environ?: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
    readonly home?: string;
  } = {},
): string {
  const environ = input.environ ?? process.env;
  const platform = input.platform ?? process.platform;
  const home = input.home ?? homedir();
  let base: string;
  if (platform === "win32") {
    const appData = environ.APPDATA?.trim();
    base =
      appData !== undefined && appData.length > 0
        ? join(appData, "deft")
        : join(home, "AppData", "Roaming", "deft");
  } else {
    const xdg = environ.XDG_CONFIG_HOME?.trim();
    base = xdg !== undefined && xdg.length > 0 ? join(xdg, "deft") : join(home, ".config", "deft");
  }
  return join(base, DELEGATION_SECRET_DIR_NAME, DELEGATION_SECRET_FILE_NAME);
}

// ---------------------------------------------------------------------------
// Enrolled secret
// ---------------------------------------------------------------------------

export interface EnrolledSecret {
  readonly secretBase32: string;
  readonly enrolledAt: string;
  readonly account: string;
}

/** Read the enrolled secret; null when absent or malformed. */
export function readEnrolledSecret(secretPath: string): EnrolledSecret | null {
  try {
    const raw = record(JSON.parse(readFileSync(secretPath, "utf8")) as unknown);
    if (raw === null) return null;
    const secretBase32 = typeof raw.secretBase32 === "string" ? raw.secretBase32.trim() : "";
    const enrolledAt = typeof raw.enrolledAt === "string" ? raw.enrolledAt : "";
    const account = typeof raw.account === "string" ? raw.account : "";
    if (secretBase32.length === 0) return null;
    return { secretBase32, enrolledAt, account };
  } catch {
    return null;
  }
}

/**
 * Write the enrolled secret (owner read/write only where the OS honours mode).
 * Refuses to replace an existing secret unless `replace` is true.
 */
export function writeEnrolledSecret(
  secretPath: string,
  secret: EnrolledSecret,
  replace: boolean,
): { ok: true } | { ok: false; reason: string } {
  const root = dirname(resolve(secretPath));
  let created = false;
  try {
    mkdirSync(root, { recursive: true });
    // Create empty, restrict the mode, then fill, so the secret is never
    // written into a file with a wider mode.
    containedWrite({ root, target: secretPath, data: "", mode: replace ? "replace" : "create" });
    created = true;
    containedChmod({ root, target: secretPath, mode: 0o600 });
    containedWrite({
      root,
      target: secretPath,
      data: `${JSON.stringify(secret, null, 2)}\n`,
      mode: "replace",
    });
    return { ok: true };
  } catch (err) {
    if (created && !replace) {
      try {
        containedRemove({ root, target: secretPath });
      } catch {
        /* best effort: a partial empty file is refused as unreadable on read */
      }
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (
      code === "EEXIST" ||
      (err instanceof ContainedWriteError && err.code === "CONTAINED_WRITE_EXISTS")
    ) {
      return { ok: false, reason: `a secret is already enrolled at ${secretPath}` };
    }
    return { ok: false, reason: `secret write failed: ${String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// State load / save
// ---------------------------------------------------------------------------

const END_REASONS: ReadonlySet<string> = new Set<DelegationEndReason>([
  "operator-off",
  "ttl-expired",
  "session-end",
  "uat-start",
  "kill-switch",
  "authz-revoke",
]);

function parseRecord(raw: unknown): DelegationRecord | null {
  const rec = record(raw);
  if (rec === null) return null;
  const str = (k: string): string | null =>
    typeof rec[k] === "string" && (rec[k] as string).length > 0 ? (rec[k] as string) : null;
  const delegationId = str("delegationId");
  const hostSessionId = str("hostSessionId");
  const armedAt = str("armedAt");
  const expiresAt = str("expiresAt");
  const host = str("host") ?? "unknown";
  if (delegationId === null || hostSessionId === null || armedAt === null || expiresAt === null) {
    return null;
  }
  if (rec.provenance !== DELEGATED_TOTP_PROVENANCE) return null;
  const armedStep = typeof rec.armedStep === "number" ? rec.armedStep : -1;
  const allow = record(rec.allowlist);
  const verbs = Array.isArray(allow?.verbs)
    ? (allow?.verbs as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  const templates = Array.isArray(allow?.templates)
    ? (allow?.templates as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  const hookAllows = Array.isArray(allow?.hookAllows)
    ? (allow?.hookAllows as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  const endedReasonRaw = str("endedReason");
  const endedReason =
    endedReasonRaw !== null && END_REASONS.has(endedReasonRaw)
      ? (endedReasonRaw as DelegationEndReason)
      : null;
  return {
    schemaVersion: DELEGATION_SCHEMA_VERSION,
    delegationId,
    hostSessionId,
    host,
    armedAt,
    expiresAt,
    armedStep,
    allowlist: { verbs, templates, hookAllows },
    provenance: DELEGATED_TOTP_PROVENANCE,
    endedAt: str("endedAt"),
    endedReason,
  };
}

export function emptyDelegationState(): DelegationState {
  return { schemaVersion: DELEGATION_SCHEMA_VERSION, lastAcceptedStep: -1, record: null };
}

export type DelegationStateLoad =
  | { readonly ok: true; readonly state: DelegationState }
  | { readonly ok: false; readonly reason: string };

/** Load store state. Missing file = empty state; unreadable file fails closed. */
export function loadDelegationState(storeRoot: string): DelegationStateLoad {
  const path = delegationStatePath(storeRoot);
  if (!existsSync(path)) return { ok: true, state: emptyDelegationState() };
  try {
    const raw = record(JSON.parse(readFileSync(path, "utf8")) as unknown);
    if (raw === null) return { ok: false, reason: `delegation state at ${path} is not an object` };
    const step = raw.lastAcceptedStep;
    if (typeof step !== "number" || !Number.isInteger(step)) {
      return { ok: false, reason: `delegation state at ${path} has no integer lastAcceptedStep` };
    }
    const rec = raw.record === null || raw.record === undefined ? null : parseRecord(raw.record);
    if (raw.record !== null && raw.record !== undefined && rec === null) {
      return { ok: false, reason: `delegation record at ${path} is malformed` };
    }
    return {
      ok: true,
      state: { schemaVersion: DELEGATION_SCHEMA_VERSION, lastAcceptedStep: step, record: rec },
    };
  } catch (err) {
    return { ok: false, reason: `delegation state unreadable at ${path}: ${String(err)}` };
  }
}

function writeJsonAtomic(storeRoot: string, targetPath: string, payload: unknown): void {
  const root = resolve(storeRoot);
  const abs = resolve(targetPath);
  mkdirSync(dirname(abs), { recursive: true });
  assertWriteTargetSafe(root, abs);
  const tmp = join(
    dirname(abs),
    `.${basename(abs)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
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

/** Persist state. Callers hold the store lock. */
export function saveDelegationState(storeRoot: string, state: DelegationState): void {
  writeJsonAtomic(storeRoot, delegationStatePath(storeRoot), state);
}

/** Append one audit line. Never throws. */
export function appendDelegationAudit(storeRoot: string, entry: DelegationAuditRecord): void {
  try {
    containedWrite({
      root: resolve(storeRoot),
      target: delegationAuditPath(storeRoot),
      data: `${JSON.stringify(entry)}\n`,
      mode: "append",
    });
  } catch {
    // Audit failure never changes the decision.
  }
}

// ---------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------

interface LockBody {
  readonly pid: number;
  readonly token: string;
  readonly startedAt: string;
}

function readLockBody(path: string): LockBody | null {
  try {
    const raw = record(JSON.parse(readFileSync(path, "utf8")) as unknown);
    if (raw === null) return null;
    const pid = typeof raw.pid === "number" ? raw.pid : Number.NaN;
    const token = typeof raw.token === "string" ? raw.token : "";
    if (!Number.isFinite(pid) || token.length === 0) return null;
    return { pid, token, startedAt: typeof raw.startedAt === "string" ? raw.startedAt : "" };
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * An unreadable lock may be a live holder between create and body write, so it
 * is reclaimable only once it is older than the lock wait (the holder is stuck).
 */
function unreadableLockIsStale(path: string): boolean {
  try {
    return Date.now() - lstatSync(path).mtimeMs > DELEGATION_LOCK_TIMEOUT_MS;
  } catch {
    return false;
  }
}

/** Rename-away reclaim of a dead holder's lock; refuses to steal a live replacement. */
function reclaimDeadLock(path: string): boolean {
  const seen = readLockBody(path);
  if (seen !== null && pidAlive(seen.pid)) return false;
  if (seen === null && !unreadableLockIsStale(path)) return false;
  const side = `${path}.reclaim.${randomBytes(6).toString("hex")}`;
  try {
    renameSync(path, side);
  } catch {
    return false;
  }
  const got = readLockBody(side);
  const same = seen === null ? got === null : got !== null && got.token === seen.token;
  if (!same) {
    try {
      renameSync(side, path);
    } catch {
      /* best-effort restore */
    }
    return false;
  }
  rmSync(side, { force: true });
  return true;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export type DelegationLockResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

/**
 * Run `fn` holding the store lock (one locked step). Cross-process: the lock is
 * an exclusive-create file; a dead holder's lock is reclaimed by rename-away.
 */
export function withDelegationLock<T>(
  storeRoot: string,
  fn: () => T,
  opts: { readonly timeoutMs?: number } = {},
): DelegationLockResult<T> {
  const root = resolve(storeRoot);
  const lockPath = delegationLockPath(storeRoot);
  const token = randomBytes(8).toString("hex");
  const body: LockBody = { pid: process.pid, token, startedAt: utcIsoSeconds(new Date()) };
  const timeout = opts.timeoutMs ?? DELEGATION_LOCK_TIMEOUT_MS;
  const started = Date.now();
  for (;;) {
    try {
      containedWrite({ root, target: lockPath, data: `${JSON.stringify(body)}\n`, mode: "create" });
      break;
    } catch (err) {
      if (!(err instanceof ContainedWriteError && err.code === "CONTAINED_WRITE_EXISTS")) {
        return { ok: false, reason: `delegation store lock failed: ${String(err)}` };
      }
    }
    if (reclaimDeadLock(lockPath)) continue;
    if (Date.now() - started > timeout) {
      return { ok: false, reason: "delegation store lock timeout; nothing was written" };
    }
    sleepSync(DELEGATION_LOCK_RETRY_MS);
  }
  try {
    return { ok: true, value: fn() };
  } finally {
    const held = readLockBody(lockPath);
    if (held !== null && held.token === token && held.pid === process.pid) {
      try {
        unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

/** True when a kill record (valid or not) exists at `root`. Presence alone ends delegation. */
export function killRecordPresent(root: string): boolean {
  try {
    lstatSync(killSwitchRecordPath(root));
    return true;
  } catch {
    return false;
  }
}

/** True when a UAT lease is active at `root`, or the authz state is unreadable (fail closed). */
export function uatActiveOrUnreadable(root: string): boolean {
  const load = loadAuthzStateResult(root);
  if (!load.ok) return true;
  return load.state.uat?.active === true;
}

/** Pure liveness of a record at `now` given the environment facts. */
export function evaluateDelegationLiveness(
  rec: DelegationRecord | null,
  ctx: { readonly now: Date; readonly uatActive: boolean; readonly killSwitch: boolean },
): DelegationLiveness {
  if (rec === null) return { live: false, reason: "no-record" };
  if (rec.endedReason !== null || rec.endedAt !== null) {
    return { live: false, reason: rec.endedReason ?? "operator-off" };
  }
  const exp = Date.parse(rec.expiresAt);
  const armed = Date.parse(rec.armedAt);
  if (
    Number.isNaN(exp) ||
    Number.isNaN(armed) ||
    exp <= ctx.now.getTime() ||
    exp - armed > DELEGATION_MAX_TTL_HOURS * MS_PER_HOUR
  ) {
    return { live: false, reason: "ttl-expired" };
  }
  if (ctx.killSwitch) return { live: false, reason: "kill-switch" };
  if (ctx.uatActive) return { live: false, reason: "uat-start" };
  return { live: true, record: rec };
}

export interface ReadLiveDelegationOptions {
  readonly now?: Date;
  /** Override the resolved store root (tests). */
  readonly storeRoot?: string;
  readonly runGit?: GitRunner;
}

/** Liveness at `projectRoot` (checks UAT and the kill record at the store root and here). */
export function readDelegationLiveness(
  projectRoot: string,
  opts: ReadLiveDelegationOptions = {},
): DelegationLiveness {
  const storeRoot = opts.storeRoot ?? resolveDelegationStoreRoot(projectRoot, opts.runGit);
  const load = loadDelegationState(storeRoot);
  if (!load.ok) return { live: false, reason: "store-unreadable" };
  const roots = [...new Set([resolve(storeRoot), resolve(projectRoot)])];
  const now = opts.now ?? new Date();
  const verdict = evaluateDelegationLiveness(load.state.record, {
    now,
    uatActive: roots.some((r) => uatActiveOrUnreadable(r)),
    killSwitch: roots.some((r) => killRecordPresent(r)),
  });
  // Persist an environment end so it stays ended after the kill record is
  // removed or the UAT lease is suspended (#7420 B2). Best effort.
  const rec = load.state.record;
  if (
    !verdict.live &&
    rec !== null &&
    rec.endedAt === null &&
    (verdict.reason === "kill-switch" ||
      verdict.reason === "uat-start" ||
      verdict.reason === "ttl-expired")
  ) {
    try {
      endDelegation(projectRoot, verdict.reason, {
        now,
        storeRoot,
        expectDelegationId: rec.delegationId,
      });
    } catch {
      /* the verdict already refuses */
    }
  }
  return verdict;
}

/** The live delegation as consumers see it, or null. */
export function readLiveDelegation(
  projectRoot: string,
  opts: ReadLiveDelegationOptions = {},
): LiveDelegationView | null {
  const live = readDelegationLiveness(projectRoot, opts);
  if (!live.live) return null;
  return {
    delegationId: live.record.delegationId,
    hostSessionId: live.record.hostSessionId,
    expiresAt: live.record.expiresAt,
    allowlist: live.record.allowlist,
  };
}

/**
 * End the record (`delegate off`, session end, UAT start, kill switch, terminal
 * `authz:revoke`). With `hostSessionId`, ends only a record armed in that
 * session. Idempotent: an already-ended record is left as it is.
 */
export function endDelegation(
  projectRoot: string,
  reason: DelegationEndReason,
  opts: {
    readonly now?: Date;
    readonly storeRoot?: string;
    readonly runGit?: GitRunner;
    readonly hostSessionId?: string;
    /** End only this record; a replaced (freshly armed) record is left alone. */
    readonly expectDelegationId?: string;
  } = {},
):
  | { readonly ok: true; readonly ended: boolean; readonly record: DelegationRecord | null }
  | { readonly ok: false; readonly reason: string } {
  const storeRoot = opts.storeRoot ?? resolveDelegationStoreRoot(projectRoot, opts.runGit);
  if (!existsSync(delegationStatePath(storeRoot))) return { ok: true, ended: false, record: null };
  const now = opts.now ?? new Date();
  const locked = withDelegationLock(storeRoot, () => {
    const load = loadDelegationState(storeRoot);
    if (!load.ok) return { ok: false as const, reason: load.reason };
    const rec = load.state.record;
    if (rec === null || rec.endedAt !== null) {
      return { ok: true as const, ended: false, record: rec };
    }
    if (opts.expectDelegationId !== undefined && opts.expectDelegationId !== rec.delegationId) {
      return { ok: true as const, ended: false, record: rec };
    }
    if (opts.hostSessionId !== undefined && opts.hostSessionId !== rec.hostSessionId) {
      return { ok: true as const, ended: false, record: rec };
    }
    const ended: DelegationRecord = { ...rec, endedAt: utcIsoSeconds(now), endedReason: reason };
    saveDelegationState(storeRoot, { ...load.state, record: ended });
    appendDelegationAudit(storeRoot, {
      schemaVersion: DELEGATION_SCHEMA_VERSION,
      ts: utcIsoSeconds(now),
      event: "end",
      provenance: DELEGATED_TOTP_PROVENANCE,
      delegationId: rec.delegationId,
      hostSessionId: rec.hostSessionId,
      detail: `ended: ${reason}`,
    });
    return { ok: true as const, ended: true, record: ended };
  });
  if (!locked.ok) return { ok: false, reason: locked.reason };
  return locked.value;
}

// ---------------------------------------------------------------------------
// Delegable-mint policy (#7420 B3 / B7)
// ---------------------------------------------------------------------------

export type DelegableMintDecision =
  | { readonly ok: true; readonly verb: string; readonly template: string | null }
  | { readonly ok: false; readonly reason: string };

/**
 * Allowlist: `scope:record-approved-scope` with no template, or `authz:grant`
 * with exactly one of the four release templates. Everything else refuses:
 * `finish-loop`, `gate-override`, `spec-drift-override`, raw-ops grants (no
 * template), `authz:uat-*`, `authz:revoke` and every other verb.
 */
export function evaluateDelegableMint(input: {
  readonly verb: string;
  readonly template: string | null | undefined;
}): DelegableMintDecision {
  const verb = input.verb.trim();
  const template =
    input.template === null || input.template === undefined
      ? null
      : input.template.trim().toLowerCase();
  if (!(DELEGABLE_MINT_VERBS as readonly string[]).includes(verb)) {
    return { ok: false, reason: `${verb} is not delegable (#7420 B7)` };
  }
  if (verb === DELEGABLE_APPROVED_SCOPE_VERB) {
    if (template !== null && template.length > 0) {
      return { ok: false, reason: `${verb} takes no template under delegation (#7420)` };
    }
    return { ok: true, verb, template: null };
  }
  if (verb === DELEGABLE_GRANT_VERB) {
    if (template === null || template.length === 0) {
      return {
        ok: false,
        reason: "authz:grant with raw operations and no template is not delegable (#7420 B7)",
      };
    }
    if (!(DELEGABLE_RELEASE_TEMPLATES as readonly string[]).includes(template)) {
      return {
        ok: false,
        reason: `authz:grant --template ${template} is not delegable (#7420 B7)`,
      };
    }
    return { ok: true, verb, template };
  }
  return { ok: false, reason: `${verb} is not delegable (#7420 B7)` };
}

/**
 * Resolve a delegated completion for a harness-attended request: the mint must
 * be on the allowlist, on the record's frozen allowlist, and the record live.
 */
export function resolveDelegatedCompletion(input: {
  readonly projectRoot: string;
  readonly verb: string;
  readonly template: string | null | undefined;
  readonly requestId: string;
  readonly now?: Date;
  readonly storeRoot?: string;
  readonly runGit?: GitRunner;
}):
  | { readonly ok: true; readonly completion: DelegatedCompletion }
  | { readonly ok: false; readonly reason: string } {
  const policy = evaluateDelegableMint({ verb: input.verb, template: input.template });
  if (!policy.ok) return policy;
  const live = readDelegationLiveness(input.projectRoot, {
    now: input.now,
    storeRoot: input.storeRoot,
    runGit: input.runGit,
  });
  if (!live.live) return { ok: false, reason: `no live delegation (${live.reason})` };
  const rec = live.record;
  if (!rec.allowlist.verbs.includes(policy.verb)) {
    return { ok: false, reason: `${policy.verb} is not on the delegation's allowlist` };
  }
  if (policy.template !== null && !rec.allowlist.templates.includes(policy.template)) {
    return {
      ok: false,
      reason: `template ${policy.template} is not on the delegation's allowlist`,
    };
  }
  return {
    ok: true,
    completion: {
      provenance: DELEGATED_TOTP_PROVENANCE,
      delegationId: rec.delegationId,
      hostSessionId: rec.hostSessionId,
      delegationExpiresAt: rec.expiresAt,
      verb: policy.verb,
      template: policy.template,
      requestId: input.requestId,
    },
  };
}

/**
 * Delegated allow-with-audit for one named hook deny condition (#7420 B5).
 * The caller (the hook dispatcher) asks only at the exact condition; this
 * checks the condition is on the code allowlist and on the live record's
 * frozen allowlist, appends one audit line and returns the chat line. Any
 * other condition, or no live record, returns `ok: false` and the caller keeps
 * its deny.
 */
export function evaluateDelegatedHookAllow(input: {
  readonly projectRoot: string;
  readonly condition: string;
  readonly detail: string;
  readonly now?: Date;
  readonly storeRoot?: string;
  readonly runGit?: GitRunner;
}):
  | { readonly ok: true; readonly delegationId: string; readonly chatLine: string }
  | { readonly ok: false; readonly reason: string } {
  if (!(DELEGABLE_HOOK_ALLOWS as readonly string[]).includes(input.condition)) {
    return { ok: false, reason: `${input.condition} is not a delegable hook condition (#7420 B5)` };
  }
  const now = input.now ?? new Date();
  const storeRoot = input.storeRoot ?? resolveDelegationStoreRoot(input.projectRoot, input.runGit);
  const live = readDelegationLiveness(input.projectRoot, { now, storeRoot });
  if (!live.live) return { ok: false, reason: `no live delegation (${live.reason})` };
  if (!(live.record.allowlist.hookAllows ?? []).includes(input.condition)) {
    return { ok: false, reason: `${input.condition} is not on the delegation's allowlist` };
  }
  appendDelegationAudit(storeRoot, {
    schemaVersion: DELEGATION_SCHEMA_VERSION,
    ts: utcIsoSeconds(now),
    event: "delegated-allow",
    provenance: DELEGATED_TOTP_PROVENANCE,
    delegationId: live.record.delegationId,
    hostSessionId: live.record.hostSessionId,
    detail: `${input.condition}: ${input.detail}`.slice(0, 2000),
  });
  return {
    ok: true,
    delegationId: live.record.delegationId,
    chatLine:
      `${DELEGATED_ACTION_CHAT_LINE_PREFIX} allowed ${input.condition} under delegation ` +
      `${live.record.delegationId}; the remaining checks still ran.`,
  };
}

/** Is `delegationId` the live delegation at `projectRoot` right now? */
export function isDelegationIdLive(
  view: LiveDelegationView | null,
  delegationId: string | null | undefined,
): boolean {
  if (view === null || delegationId === null || delegationId === undefined) return false;
  return delegationId.length > 0 && view.delegationId === delegationId;
}
