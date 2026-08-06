/**
 * Durable delivery-attempt unit ledger (#3143).
 *
 * Persists under `.deft/delivery-attempts/` so counters survive worker
 * replacement, session restart, context compaction, and new revisions.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { assertWriteTargetSafe } from "../fs/projection-containment.js";
import type {
  AttemptStatus,
  AttemptTrigger,
  DeliveryAttemptRecord,
  DeliveryUnitLedger,
  FailureInfo,
  MaterialDeltaClaim,
  OperatorOverride,
  PreDispatchDecision,
  ResumeCondition,
} from "./types.js";
import {
  DELIVERY_ATTEMPT_DIR,
  DELIVERY_ATTEMPT_SCHEMA_VERSION,
  deliveryUnitKey,
  utcIso,
} from "./types.js";

export function deliveryAttemptsDir(projectRoot: string): string {
  return join(projectRoot, ...DELIVERY_ATTEMPT_DIR.split("/"));
}

/**
 * Stable collision-resistant filename for a unit key.
 * Full SHA-256 hex (64 chars) — do not truncate base64 of the raw key (#3143 P1).
 */
export function unitLedgerFilename(scopeId: string, targetId: string, workflowId: string): string {
  const key = deliveryUnitKey(scopeId, targetId, workflowId);
  const digest = createHash("sha256").update(key, "utf8").digest("hex");
  return `${digest}.json`;
}

export function unitLedgerPath(
  projectRoot: string,
  scopeId: string,
  targetId: string,
  workflowId: string,
): string {
  return join(deliveryAttemptsDir(projectRoot), unitLedgerFilename(scopeId, targetId, workflowId));
}

export function newAttemptId(prefix = "att"): string {
  return `${prefix}-${randomBytes(8).toString("hex")}`;
}

export function emptyUnitLedger(input: {
  readonly scopeId: string;
  readonly targetId: string;
  readonly workflowId: string;
  readonly phaseId?: string;
  readonly now?: string;
}): DeliveryUnitLedger {
  return {
    schemaVersion: DELIVERY_ATTEMPT_SCHEMA_VERSION,
    scopeId: input.scopeId,
    targetId: input.targetId,
    workflowId: input.workflowId,
    phaseId: input.phaseId ?? "default",
    attempts: [],
    failedAttemptCount: 0,
    sameFailureCounts: {},
    totalElapsedSeconds: 0,
    totalToolCallCount: 0,
    totalHostTokenCount: null,
    lastFailure: null,
    lastMaterialDelta: [],
    lastSourceRevision: null,
    blockedDecision: null,
    resumeCondition: null,
    override: null,
    updatedAt: utcIso(input.now),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(rec: Record<string, unknown>, key: string): string | null {
  const v = rec[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function readNumber(rec: Record<string, unknown>, key: string): number | null {
  const v = rec[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Parse a unit ledger from JSON. Returns null when required fields are invalid.
 */
export function parseUnitLedger(raw: unknown): DeliveryUnitLedger | null {
  if (!isRecord(raw)) return null;
  const scopeId = readString(raw, "scopeId");
  const targetId = readString(raw, "targetId");
  const workflowId = readString(raw, "workflowId");
  if (scopeId === null || targetId === null || workflowId === null) return null;

  const attemptsRaw = Array.isArray(raw.attempts) ? raw.attempts : [];
  const attempts: DeliveryAttemptRecord[] = [];
  for (const a of attemptsRaw) {
    const parsed = parseAttempt(a);
    if (parsed !== null) attempts.push(parsed);
  }

  const sameFailureCounts: Record<string, number> = {};
  if (isRecord(raw.sameFailureCounts)) {
    for (const [k, v] of Object.entries(raw.sameFailureCounts)) {
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
        sameFailureCounts[k] = Math.floor(v);
      }
    }
  }

  return {
    schemaVersion: DELIVERY_ATTEMPT_SCHEMA_VERSION,
    scopeId,
    targetId,
    workflowId,
    phaseId: readString(raw, "phaseId") ?? "default",
    attempts,
    failedAttemptCount: Math.max(0, Math.floor(readNumber(raw, "failedAttemptCount") ?? 0)),
    sameFailureCounts,
    totalElapsedSeconds: Math.max(0, Math.floor(readNumber(raw, "totalElapsedSeconds") ?? 0)),
    totalToolCallCount: Math.max(0, Math.floor(readNumber(raw, "totalToolCallCount") ?? 0)),
    totalHostTokenCount:
      raw.totalHostTokenCount === null || raw.totalHostTokenCount === undefined
        ? null
        : Math.max(0, Math.floor(readNumber(raw, "totalHostTokenCount") ?? 0)),
    lastFailure: parseFailure(raw.lastFailure),
    lastMaterialDelta: parseMaterialDeltas(raw.lastMaterialDelta),
    lastSourceRevision: readString(raw, "lastSourceRevision"),
    blockedDecision: (readString(raw, "blockedDecision") as PreDispatchDecision | null) ?? null,
    resumeCondition: parseResume(raw.resumeCondition),
    override: parseOverride(raw.override),
    updatedAt: readString(raw, "updatedAt") ?? utcIso(),
  };
}

function parseFailure(raw: unknown): FailureInfo | null {
  if (!isRecord(raw)) return null;
  const stage = readString(raw, "stage");
  const fingerprint = readString(raw, "fingerprint");
  const retryability = readString(raw, "retryability");
  if (stage === null || fingerprint === null || retryability === null) return null;
  if (
    retryability !== "transient" &&
    retryability !== "deterministic" &&
    retryability !== "unknown"
  ) {
    return null;
  }
  return {
    stage,
    code: readString(raw, "code"),
    fingerprint,
    retryability,
    resourceClass: readString(raw, "resourceClass"),
  };
}

function parseMaterialDeltas(raw: unknown): MaterialDeltaClaim[] {
  if (!Array.isArray(raw)) return [];
  const out: MaterialDeltaClaim[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const kind = readString(item, "kind");
    const sourceRevision = readString(item, "sourceRevision");
    if (kind === null || sourceRevision === null) continue;
    const addresses = Array.isArray(item.addresses)
      ? item.addresses.filter((x): x is string => typeof x === "string")
      : [];
    out.push({
      kind: kind as MaterialDeltaClaim["kind"],
      addresses,
      sourceRevision,
      note: readString(item, "note"),
    });
  }
  return out;
}

function parseAttempt(raw: unknown): DeliveryAttemptRecord | null {
  if (!isRecord(raw)) return null;
  const attemptId = readString(raw, "attemptId");
  const sourceRevision = readString(raw, "sourceRevision");
  const trigger = readString(raw, "trigger") as AttemptTrigger | null;
  const status = readString(raw, "status") as AttemptStatus | null;
  const startedAt = readString(raw, "startedAt");
  if (
    attemptId === null ||
    sourceRevision === null ||
    trigger === null ||
    status === null ||
    startedAt === null
  ) {
    return null;
  }
  return {
    attemptId,
    sourceRevision,
    trigger,
    status,
    failure: parseFailure(raw.failure),
    materialDelta: parseMaterialDeltas(raw.materialDelta),
    startedAt,
    endedAt: readString(raw, "endedAt"),
    elapsedSeconds: Math.max(0, Math.floor(readNumber(raw, "elapsedSeconds") ?? 0)),
    toolCallCount: Math.max(0, Math.floor(readNumber(raw, "toolCallCount") ?? 0)),
    hostTokenCount:
      raw.hostTokenCount === null || raw.hostTokenCount === undefined
        ? null
        : Math.max(0, Math.floor(readNumber(raw, "hostTokenCount") ?? 0)),
    workerId: readString(raw, "workerId"),
    externalRunId: readString(raw, "externalRunId"),
  };
}

function parseResume(raw: unknown): ResumeCondition | null {
  if (!isRecord(raw)) return null;
  const kind = readString(raw, "kind");
  const description = readString(raw, "description");
  if (kind === null || description === null) return null;
  return {
    kind: kind as ResumeCondition["kind"],
    description,
    satisfied: raw.satisfied === true,
  };
}

function parseOverride(raw: unknown): OperatorOverride | null {
  if (!isRecord(raw)) return null;
  const overrideId = readString(raw, "overrideId");
  const actor = readString(raw, "actor");
  const rationale = readString(raw, "rationale");
  const recordedAt = readString(raw, "recordedAt");
  if (overrideId === null || actor === null || rationale === null || recordedAt === null) {
    return null;
  }
  return {
    overrideId,
    actor,
    rationale,
    recordedAt,
    allowedAttempts: Math.max(1, Math.floor(readNumber(raw, "allowedAttempts") ?? 1)),
    expiresAt: readString(raw, "expiresAt"),
    remainingAttempts: Math.max(0, Math.floor(readNumber(raw, "remainingAttempts") ?? 0)),
  };
}

function writeJsonContained(projectRoot: string, targetPath: string, payload: unknown): void {
  const root = resolve(projectRoot);
  const abs = resolve(targetPath);
  assertWriteTargetSafe(root, abs);
  mkdirSync(dirname(abs), { recursive: true });
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
      /* best-effort */
    }
    throw err;
  }
}

/** Load unit ledger from disk, or null if missing/corrupt. */
export function loadUnitLedger(
  projectRoot: string,
  scopeId: string,
  targetId: string,
  workflowId: string,
): DeliveryUnitLedger | null {
  const path = unitLedgerPath(projectRoot, scopeId, targetId, workflowId);
  if (!existsSync(path)) return null;
  try {
    return parseUnitLedger(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return null;
  }
}

/** Persist unit ledger atomically under project root. */
export function saveUnitLedger(projectRoot: string, ledger: DeliveryUnitLedger): void {
  const path = unitLedgerPath(projectRoot, ledger.scopeId, ledger.targetId, ledger.workflowId);
  writeJsonContained(projectRoot, path, ledger);
}

/**
 * Exclusive unit lock for begin/complete on disk (#3143 concurrent-snapshot P1).
 * Uses O_EXCL create of a lock file under the delivery-attempts dir.
 */
/** Stale lock age (ms): live PID older than this is treated as PID-reuse residual. */
export const UNIT_LOCK_STALE_MS = 5 * 60 * 1000;

interface UnitLockRecord {
  readonly pid: number;
  readonly token: string;
  readonly startedAt: string;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockRecord(lockPath: string): UnitLockRecord | null {
  try {
    const raw = JSON.parse(readFileSync(lockPath, "utf8")) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const rec = raw as Record<string, unknown>;
    const pid = typeof rec.pid === "number" ? rec.pid : Number.NaN;
    const token = typeof rec.token === "string" ? rec.token : "";
    const startedAt = typeof rec.startedAt === "string" ? rec.startedAt : "";
    if (!Number.isFinite(pid) || token.length === 0) return null;
    return { pid, token, startedAt };
  } catch {
    return null;
  }
}

function lockStartedAtMs(rec: UnitLockRecord): number | null {
  const t = Date.parse(rec.startedAt);
  return Number.isFinite(t) ? t : null;
}

/**
 * Whether an existing lock may be reclaimed.
 * - unreadable/corrupt → reclaimable
 * - owner PID dead → reclaimable
 * - owner PID alive with fresh lock mtime/heartbeat → NOT reclaimable
 *   (long critical sections keep heartbeat via utimes; never revoke live holders)
 * - owner PID alive but lock mtime older than staleMs → reclaimable (PID reuse
 *   residual: a different process inherited the pid number and is not heartbeating)
 * - when lockPath is omitted (pure tests): fall back to startedAt age
 */
export function isUnitLockReclaimable(
  rec: UnitLockRecord | null,
  nowMs: number,
  staleMs: number = UNIT_LOCK_STALE_MS,
  lockPath?: string,
): boolean {
  if (rec === null) return true;
  if (!isProcessAlive(rec.pid)) return true;
  if (lockPath !== undefined) {
    try {
      const st = statSync(lockPath);
      return nowMs - st.mtimeMs >= staleMs;
    } catch {
      return true;
    }
  }
  const started = lockStartedAtMs(rec);
  return started !== null && nowMs - started >= staleMs;
}

function writeLockExclusive(path: string, record: UnitLockRecord): void {
  writeFileSync(path, `${JSON.stringify(record)}\n`, { flag: "wx", encoding: "utf8" });
}

function unlinkIfOurs(path: string, token: string, pid: number): void {
  const rec = readLockRecord(path);
  if (rec !== null && rec.token === token && rec.pid === pid) {
    try {
      unlinkSync(path);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Acquire exclusive unit lock.
 *
 * Create is atomic: `writeFileSync(..., { flag: "wx" })` writes the owner
 * record in the exclusive create (no empty-file window).
 *
 * Recovery when EEXIST (abandoned / corrupt / PID-reuse stale):
 * 1. Take an exclusive **reclaim ticket** (`*.lock.reclaim`) with `wx`.
 * 2. Under that ticket, re-read the lock; only unlink if still reclaimable.
 * 3. Create the replacement lock with `wx`, then drop the ticket.
 *
 * The ticket serializes reclaimers so a delayed contender cannot unlink a
 * live replacement lock (Greptile P1: stale recovery revokes replacement).
 */
export function withUnitLock<T>(
  projectRoot: string,
  scopeId: string,
  targetId: string,
  workflowId: string,
  fn: () => T,
  options?: { readonly nowMs?: number; readonly staleMs?: number },
): T {
  const dir = deliveryAttemptsDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  const lockName = `${unitLedgerFilename(scopeId, targetId, workflowId)}.lock`;
  const lockPath = join(dir, lockName);
  const reclaimPath = `${lockPath}.reclaim`;
  const root = resolve(projectRoot);
  assertWriteTargetSafe(root, lockPath);
  assertWriteTargetSafe(root, reclaimPath);
  const nowMs = options?.nowMs ?? Date.now();
  const staleMs = options?.staleMs ?? UNIT_LOCK_STALE_MS;
  const token = randomBytes(8).toString("hex");
  const record: UnitLockRecord = {
    pid: process.pid,
    token,
    startedAt: new Date(nowMs).toISOString(),
  };
  const unitLabel = `${scopeId}/${targetId}/${workflowId}`;

  const heldError = (detail: string, cause?: unknown): Error =>
    new Error(`delivery-attempt unit lock held for ${unitLabel}${detail}`, cause ? { cause } : undefined);

  const tryCreateLock = (): void => {
    writeLockExclusive(lockPath, record);
  };

  const acquireReclaimTicket = (): void => {
    try {
      writeLockExclusive(reclaimPath, record);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
    }
    // Existing reclaim ticket — only take over if reclaimable (dead/stale heartbeat).
    const existingReclaim = readLockRecord(reclaimPath);
    if (!isUnitLockReclaimable(existingReclaim, nowMs, staleMs, reclaimPath)) {
      const pid = existingReclaim?.pid;
      throw heldError(pid !== undefined ? ` (reclaim by pid ${pid})` : " (reclaim in progress)");
    }
    try {
      unlinkSync(reclaimPath);
    } catch {
      /* race */
    }
    try {
      writeLockExclusive(reclaimPath, record);
    } catch (retryErr) {
      throw heldError(" (reclaim in progress)", retryErr);
    }
  };

  try {
    tryCreateLock();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw err;

    const existing = readLockRecord(lockPath);
    if (!isUnitLockReclaimable(existing, nowMs, staleMs, lockPath)) {
      throw heldError(
        existing !== null ? ` by pid ${existing.pid}` : "",
      );
    }

    // Serialize reclaim so we never unlink another worker's replacement lock.
    acquireReclaimTicket();
    try {
      const again = readLockRecord(lockPath);
      if (!isUnitLockReclaimable(again, nowMs, staleMs, lockPath)) {
        throw heldError(again !== null ? ` by pid ${again.pid}` : "");
      }
      try {
        unlinkSync(lockPath);
      } catch {
        /* already gone */
      }
      try {
        tryCreateLock();
      } catch (retryErr) {
        throw heldError("; retry after the other worker finishes", retryErr);
      }
    } finally {
      unlinkIfOurs(reclaimPath, token, process.pid);
    }
  }

  // Heartbeat while holding: refresh mtime so long critical sections are never
  // treated as PID-reuse stale. Interval is unref'd so tests/CLI can exit.
  const hbMs = Math.max(1_000, Math.min(Math.floor(staleMs / 3), 30_000));
  const heartbeat = setInterval(() => {
    try {
      const t = new Date();
      utimesSync(lockPath, t, t);
    } catch {
      /* released or raced */
    }
  }, hbMs);
  if (typeof heartbeat.unref === "function") {
    heartbeat.unref();
  }

  try {
    return fn();
  } finally {
    clearInterval(heartbeat);
    unlinkIfOurs(lockPath, token, process.pid);
  }
}

/** Load or create empty unit ledger. */
export function loadOrCreateUnitLedger(
  projectRoot: string,
  input: {
    readonly scopeId: string;
    readonly targetId: string;
    readonly workflowId: string;
    readonly phaseId?: string;
    readonly now?: string;
  },
): DeliveryUnitLedger {
  return (
    loadUnitLedger(projectRoot, input.scopeId, input.targetId, input.workflowId) ??
    emptyUnitLedger(input)
  );
}

export function listUnitLedgers(projectRoot: string): DeliveryUnitLedger[] {
  const dir = deliveryAttemptsDir(projectRoot);
  if (!existsSync(dir)) return [];
  const out: DeliveryUnitLedger[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const ledger = parseUnitLedger(JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown);
      if (ledger !== null) out.push(ledger);
    } catch {
      /* skip corrupt */
    }
  }
  return out;
}

export function activeAttempts(ledger: DeliveryUnitLedger): readonly DeliveryAttemptRecord[] {
  return ledger.attempts.filter((a) => a.status === "queued" || a.status === "running");
}

export function hasActiveAttempt(ledger: DeliveryUnitLedger): boolean {
  return activeAttempts(ledger).length > 0;
}

/**
 * Open a new queued/running attempt. Caller must have passed evaluatePreDispatch.
 * Does not re-check the gate (orchestrators own the order: evaluate → begin).
 */
export function beginAttempt(
  ledger: DeliveryUnitLedger,
  input: {
    readonly attemptId?: string;
    readonly sourceRevision: string;
    readonly trigger: AttemptTrigger;
    readonly status?: "queued" | "running";
    readonly workerId?: string | null;
    readonly externalRunId?: string | null;
    readonly materialDelta?: readonly MaterialDeltaClaim[];
    readonly now?: string;
  },
): { ledger: DeliveryUnitLedger; attempt: DeliveryAttemptRecord } {
  const now = utcIso(input.now);
  const attempt: DeliveryAttemptRecord = {
    attemptId: input.attemptId ?? newAttemptId(),
    sourceRevision: input.sourceRevision,
    trigger: input.trigger,
    status: input.status ?? "running",
    failure: null,
    materialDelta: input.materialDelta ?? [],
    startedAt: now,
    endedAt: null,
    elapsedSeconds: 0,
    toolCallCount: 0,
    hostTokenCount: null,
    workerId: input.workerId ?? null,
    externalRunId: input.externalRunId ?? null,
  };

  // Consume override allowance on any begin while remainingAttempts > 0.
  // evaluatePreDispatch may ALLOW_OVERRIDE while the caller still passes
  // trigger "automatic" / "retry" (#3143 Greptile P1).
  let override = ledger.override;
  if (override !== null && override.remainingAttempts > 0) {
    override = { ...override, remainingAttempts: override.remainingAttempts - 1 };
  }

  const next: DeliveryUnitLedger = {
    ...ledger,
    attempts: [...ledger.attempts, attempt],
    lastSourceRevision: input.sourceRevision,
    lastMaterialDelta:
      input.materialDelta && input.materialDelta.length > 0
        ? input.materialDelta
        : ledger.lastMaterialDelta,
    blockedDecision: null,
    override,
    updatedAt: now,
  };
  return { ledger: next, attempt };
}

/**
 * Record terminal outcome for an attempt. Increments budgets / sameFailureCounts
 * on failure. Idempotent when the same externalRunId is already terminal.
 */
export function completeAttempt(
  ledger: DeliveryUnitLedger,
  input: {
    readonly attemptId?: string;
    readonly externalRunId?: string | null;
    readonly status: "succeeded" | "failed" | "cancelled" | "blocked";
    readonly failure?: FailureInfo | null;
    readonly materialDelta?: readonly MaterialDeltaClaim[];
    readonly elapsedSeconds?: number;
    readonly toolCallCount?: number;
    readonly hostTokenCount?: number | null;
    readonly now?: string;
  },
): DeliveryUnitLedger {
  const now = utcIso(input.now);

  // Interrupted-run reconciliation: if an active attempt with this externalRunId
  // exists, complete it. Only no-op when the run is already terminal AND no
  // active attempt shares that externalRunId (CI re-runs may reuse ids — #3143).
  if (input.externalRunId) {
    const activeWithRun = ledger.attempts.find(
      (a) =>
        a.externalRunId === input.externalRunId &&
        (a.status === "queued" || a.status === "running"),
    );
    if (activeWithRun === undefined) {
      const terminalWithRun = ledger.attempts.find(
        (a) =>
          a.externalRunId === input.externalRunId &&
          (a.status === "succeeded" ||
            a.status === "failed" ||
            a.status === "cancelled" ||
            a.status === "blocked"),
      );
      if (terminalWithRun !== undefined) {
        return ledger;
      }
    }
  }

  let idx = -1;
  if (input.attemptId) {
    idx = ledger.attempts.findIndex((a) => a.attemptId === input.attemptId);
  } else if (input.externalRunId) {
    idx = ledger.attempts.findIndex(
      (a) =>
        a.externalRunId === input.externalRunId &&
        (a.status === "queued" || a.status === "running"),
    );
  } else {
    // Latest active
    for (let i = ledger.attempts.length - 1; i >= 0; i--) {
      const a = ledger.attempts[i];
      if (a !== undefined && (a.status === "queued" || a.status === "running")) {
        idx = i;
        break;
      }
    }
  }

  if (idx < 0) {
    // No open attempt — still allow recording a synthetic terminal for reconciliation.
    const synthetic: DeliveryAttemptRecord = {
      attemptId: newAttemptId("rec"),
      sourceRevision: ledger.lastSourceRevision ?? "unknown",
      trigger: "automatic",
      status: input.status,
      failure: input.failure ?? null,
      materialDelta: input.materialDelta ?? [],
      startedAt: now,
      endedAt: now,
      elapsedSeconds: input.elapsedSeconds ?? 0,
      toolCallCount: input.toolCallCount ?? 0,
      hostTokenCount: input.hostTokenCount ?? null,
      workerId: null,
      externalRunId: input.externalRunId ?? null,
    };
    return applyTerminal(ledger, synthetic, input, now, true);
  }

  const prev = ledger.attempts[idx];
  if (prev === undefined) {
    return ledger;
  }
  if (
    prev.status === "succeeded" ||
    prev.status === "failed" ||
    prev.status === "cancelled" ||
    prev.status === "blocked"
  ) {
    // Already terminal — do not double-count.
    return ledger;
  }

  const updated: DeliveryAttemptRecord = {
    ...prev,
    status: input.status,
    failure: input.failure ?? prev.failure,
    materialDelta: input.materialDelta ?? prev.materialDelta,
    endedAt: now,
    elapsedSeconds: input.elapsedSeconds ?? prev.elapsedSeconds,
    toolCallCount: input.toolCallCount ?? prev.toolCallCount,
    hostTokenCount: input.hostTokenCount === undefined ? prev.hostTokenCount : input.hostTokenCount,
    externalRunId: input.externalRunId ?? prev.externalRunId,
  };

  const attempts = ledger.attempts.slice();
  attempts[idx] = updated;
  const withAttempt: DeliveryUnitLedger = { ...ledger, attempts };
  return applyTerminal(withAttempt, updated, input, now, false);
}

function applyTerminal(
  ledger: DeliveryUnitLedger,
  attempt: DeliveryAttemptRecord,
  input: {
    readonly status: "succeeded" | "failed" | "cancelled" | "blocked";
    readonly failure?: FailureInfo | null;
    readonly materialDelta?: readonly MaterialDeltaClaim[];
    readonly elapsedSeconds?: number;
    readonly toolCallCount?: number;
    readonly hostTokenCount?: number | null;
  },
  now: string,
  appendSynthetic: boolean,
): DeliveryUnitLedger {
  const failure = input.failure ?? attempt.failure;
  const elapsed = input.elapsedSeconds ?? attempt.elapsedSeconds;
  const tools = input.toolCallCount ?? attempt.toolCallCount;
  const tokens = input.hostTokenCount === undefined ? attempt.hostTokenCount : input.hostTokenCount;

  let failedAttemptCount = ledger.failedAttemptCount;
  const sameFailureCounts = { ...ledger.sameFailureCounts };
  if (input.status === "failed" || input.status === "blocked") {
    failedAttemptCount += 1;
    if (failure !== null) {
      sameFailureCounts[failure.fingerprint] = (sameFailureCounts[failure.fingerprint] ?? 0) + 1;
    }
  }

  let totalHost = ledger.totalHostTokenCount;
  if (tokens !== null && tokens !== undefined) {
    totalHost = (totalHost ?? 0) + tokens;
  }

  const attempts = appendSynthetic ? [...ledger.attempts, attempt] : ledger.attempts;

  // Success closes the active failure identity for this unit (transient recovery
  // path). Phase aggregate counters remain for observability / attempt budget.
  const lastFailure = input.status === "succeeded" ? null : (failure ?? ledger.lastFailure);

  return {
    ...ledger,
    attempts,
    failedAttemptCount,
    sameFailureCounts,
    totalElapsedSeconds: ledger.totalElapsedSeconds + elapsed,
    totalToolCallCount: ledger.totalToolCallCount + tools,
    totalHostTokenCount: totalHost,
    lastFailure,
    lastMaterialDelta: input.materialDelta ?? attempt.materialDelta ?? ledger.lastMaterialDelta,
    lastSourceRevision: attempt.sourceRevision,
    blockedDecision: input.status === "succeeded" ? null : ledger.blockedDecision,
    resumeCondition: input.status === "succeeded" ? null : ledger.resumeCondition,
    updatedAt: now,
  };
}

/** Mark unit blocked with resume condition (persisted before worker exit). */
export function markBlocked(
  ledger: DeliveryUnitLedger,
  decision: PreDispatchDecision,
  resume: ResumeCondition,
  now?: string,
): DeliveryUnitLedger {
  return {
    ...ledger,
    blockedDecision: decision,
    resumeCondition: resume,
    updatedAt: utcIso(now),
  };
}

/** Clear block when resume condition is satisfied (caller sets satisfied=true). */
export function clearBlockIfResumed(ledger: DeliveryUnitLedger, now?: string): DeliveryUnitLedger {
  if (ledger.resumeCondition === null || !ledger.resumeCondition.satisfied) {
    return ledger;
  }
  return {
    ...ledger,
    blockedDecision: null,
    resumeCondition: { ...ledger.resumeCondition, satisfied: true },
    updatedAt: utcIso(now),
  };
}

/**
 * Record an audited operator override. Preserves full attempt history.
 * remainingAttempts starts at allowedAttempts.
 */
export function recordOperatorOverride(
  ledger: DeliveryUnitLedger,
  input: {
    readonly actor: string;
    readonly rationale: string;
    readonly allowedAttempts?: number;
    readonly expiresAt?: string | null;
    readonly now?: string;
  },
): DeliveryUnitLedger {
  const now = utcIso(input.now);
  const allowed = Math.max(1, input.allowedAttempts ?? 1);
  const override: OperatorOverride = {
    overrideId: `ovr-${randomBytes(6).toString("hex")}`,
    actor: input.actor,
    rationale: input.rationale,
    recordedAt: now,
    allowedAttempts: allowed,
    expiresAt: input.expiresAt ?? null,
    remainingAttempts: allowed,
  };
  return {
    ...ledger,
    override,
    blockedDecision: null,
    resumeCondition: {
      kind: "operator-override",
      description: `operator override by ${input.actor}: ${input.rationale}`,
      satisfied: true,
    },
    updatedAt: now,
  };
}

/** In-memory ledger store for tests and pure evaluation paths. */
export class MemoryLedgerStore {
  private readonly map = new Map<string, DeliveryUnitLedger>();

  get(scopeId: string, targetId: string, workflowId: string): DeliveryUnitLedger | null {
    return this.map.get(deliveryUnitKey(scopeId, targetId, workflowId)) ?? null;
  }

  set(ledger: DeliveryUnitLedger): void {
    this.map.set(deliveryUnitKey(ledger.scopeId, ledger.targetId, ledger.workflowId), ledger);
  }

  getOrCreate(input: {
    readonly scopeId: string;
    readonly targetId: string;
    readonly workflowId: string;
    readonly phaseId?: string;
    readonly now?: string;
  }): DeliveryUnitLedger {
    const existing = this.get(input.scopeId, input.targetId, input.workflowId);
    if (existing) return existing;
    const empty = emptyUnitLedger(input);
    this.set(empty);
    return empty;
  }

  clear(): void {
    this.map.clear();
  }
}
