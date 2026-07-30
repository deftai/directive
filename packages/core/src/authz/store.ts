/**
 * Disk store for authz state + grants under `.deft/authz/` (#2944).
 */

import {
  closeSync,
  existsSync,
  fdatasyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
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

function atomicWriteJson(targetPath: string, payload: unknown, prefix: string): void {
  mkdirSync(join(targetPath, ".."), { recursive: true });
  const dir = join(targetPath, "..");
  const tmpName = join(dir, `${prefix}${process.pid}.json.tmp`);
  const fd = openSync(tmpName, "w");
  try {
    const text = `${JSON.stringify(payload, null, 2)}\n`;
    writeSync(fd, text, undefined, "utf8");
    try {
      fdatasyncSync(fd);
    } catch {
      // best-effort on platforms without fdatasync
    }
  } finally {
    closeSync(fd);
  }
  renameSync(tmpName, targetPath);
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

export function saveAuthzState(projectRoot: string, state: AuthzState): void {
  atomicWriteJson(authzStatePath(projectRoot), state, ".authz-state.");
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
  atomicWriteJson(authzGrantPath(projectRoot, grant.id), grant, ".authz-grant.");
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
  const path = authzAuditPath(projectRoot);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record)}\n`, { flag: "a", encoding: "utf8" });
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
