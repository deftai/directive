/**
 * Durable delivery-attempt unit ledger (#3143).
 *
 * Persists under `.deft/delivery-attempts/` so counters survive worker
 * replacement, session restart, context compaction, and new revisions.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
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

export function unitLedgerFilename(scopeId: string, targetId: string, workflowId: string): string {
  const key = deliveryUnitKey(scopeId, targetId, workflowId);
  const safe = Buffer.from(key, "utf8").toString("base64url").slice(0, 120);
  return `${safe}.json`;
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

  let override = ledger.override;
  if (override !== null && override.remainingAttempts > 0 && input.trigger === "override") {
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

  // Interrupted-run reconciliation: same externalRunId already terminal → no-op.
  if (input.externalRunId) {
    const existing = ledger.attempts.find(
      (a) =>
        a.externalRunId === input.externalRunId &&
        (a.status === "succeeded" ||
          a.status === "failed" ||
          a.status === "cancelled" ||
          a.status === "blocked"),
    );
    if (existing) {
      return ledger;
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
