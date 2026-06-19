import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { AUDIT_LOG_REL_PATH } from "./constants.js";
import { utcNowIso } from "./vbrief-json.js";

export class ScopeAuditLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeAuditLogError";
  }
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ISO8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const REQUIRED_FIELDS = [
  "decision_id",
  "timestamp",
  "action",
  "vbrief_path",
  "from_status",
  "to_status",
  "actor",
] as const;

const DEMOTE_META_REQUIRED = [
  "was_promoted",
  "original_promotion_decision_id",
  "days_in_pending",
  "demote_reason",
  "demoted_from",
] as const;

let threadLock = false;

function replacerSortKeys(_key: string, value: unknown): unknown {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

function validateDemoteMeta(meta: Record<string, unknown>): void {
  const missing = DEMOTE_META_REQUIRED.filter((f) => !(f in meta));
  if (missing.length > 0) {
    throw new ScopeAuditLogError(`demote_meta missing required field(s): ${missing}`);
  }
  if (typeof meta.was_promoted !== "boolean") {
    throw new ScopeAuditLogError(
      `demote_meta.was_promoted must be bool, got ${JSON.stringify(meta.was_promoted)}`,
    );
  }
  const opdid = meta.original_promotion_decision_id;
  if (opdid !== null && (typeof opdid !== "string" || !UUID_RE.test(opdid))) {
    throw new ScopeAuditLogError(
      `demote_meta.original_promotion_decision_id must be a UUID string or null, got ${JSON.stringify(opdid)}`,
    );
  }
  const days = meta.days_in_pending;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 0) {
    throw new ScopeAuditLogError(
      `demote_meta.days_in_pending must be a non-negative int, got ${JSON.stringify(days)}`,
    );
  }
  if (typeof meta.demote_reason !== "string" || meta.demote_reason.length === 0) {
    throw new ScopeAuditLogError(
      `demote_meta.demote_reason must be a non-empty string, got ${JSON.stringify(meta.demote_reason)}`,
    );
  }
  if (typeof meta.demoted_from !== "string" || meta.demoted_from.length === 0) {
    throw new ScopeAuditLogError(
      `demote_meta.demoted_from must be a non-empty string, got ${JSON.stringify(meta.demoted_from)}`,
    );
  }
}

function validateEntry(entry: unknown): void {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new ScopeAuditLogError(
      `entry must be a dict, got ${entry === null ? "None" : typeof entry}`,
    );
  }
  const e = entry as Record<string, unknown>;
  const missing = REQUIRED_FIELDS.filter((f) => !(f in e));
  if (missing.length > 0) {
    throw new ScopeAuditLogError(`entry missing required field(s): ${missing}`);
  }
  if (typeof e.decision_id !== "string" || !UUID_RE.test(e.decision_id)) {
    throw new ScopeAuditLogError(
      `decision_id must be a UUID string, got ${JSON.stringify(e.decision_id)}`,
    );
  }
  if (typeof e.timestamp !== "string" || !ISO8601_RE.test(e.timestamp)) {
    throw new ScopeAuditLogError(
      `timestamp must be ISO-8601 UTC with Z suffix, got ${JSON.stringify(e.timestamp)}`,
    );
  }
  for (const field of ["action", "vbrief_path", "from_status", "to_status", "actor"] as const) {
    const value = e[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new ScopeAuditLogError(
        `${field} must be a non-empty string, got ${JSON.stringify(value)}`,
      );
    }
  }
  if (e.action === "demote") {
    const meta = e.demote_meta;
    if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
      throw new ScopeAuditLogError(
        `action='demote' requires a 'demote_meta' object, got ${JSON.stringify(meta)}`,
      );
    }
    validateDemoteMeta(meta as Record<string, unknown>);
  }
}

export function newDecisionId(): string {
  return randomUUID();
}

export function canonicalLogPath(projectRoot: string): string {
  return join(resolve(projectRoot), AUDIT_LOG_REL_PATH);
}

function withAppendLock(logPath: string, fn: () => void): void {
  const lockPath = `${logPath}.lock`;
  mkdirSync(dirname(logPath), { recursive: true });
  while (threadLock) {
    /* spin-wait for in-process serialization */
  }
  threadLock = true;
  let fd: number | null = null;
  try {
    fd = openSync(lockPath, "a+");
    if (readFileSync(lockPath).length === 0) {
      writeSync(fd, "\0");
    }
    fn();
  } finally {
    threadLock = false;
    if (fd !== null) {
      closeSync(fd);
    }
    try {
      if (existsSync(lockPath)) {
        unlinkSync(lockPath);
      }
    } catch {
      /* best-effort lock cleanup */
    }
  }
}

/** Validate and append an audit entry; returns decision_id. */
export function append(entry: Record<string, unknown>, logPath: string): string {
  if (logPath.length === 0) {
    throw new ScopeAuditLogError("append() requires log_path; pass canonicalLogPath(projectRoot)");
  }
  validateEntry(entry);
  const logFile = resolve(logPath);
  mkdirSync(join(logFile, ".."), { recursive: true });
  const line = JSON.stringify(entry, replacerSortKeys);
  withAppendLock(logFile, () => {
    writeFileSync(logFile, `${line}\n`, { encoding: "utf8", flag: "a" });
  });
  return String(entry.decision_id);
}

/** Read all well-formed audit entries in insertion order. */
export function readAll(logPath: string): Record<string, unknown>[] {
  if (logPath.length === 0) {
    throw new ScopeAuditLogError("readAll() requires log_path; pass canonicalLogPath(projectRoot)");
  }
  const logFile = resolve(logPath);
  if (!existsSync(logFile)) {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  const raw = readFileSync(logFile, "utf8");
  for (const line of raw.split("\n")) {
    const stripped = line.trim();
    if (stripped.length === 0) {
      continue;
    }
    try {
      const obj = JSON.parse(stripped) as unknown;
      if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
        out.push(obj as Record<string, unknown>);
      }
    } catch {
      /* skip malformed lines */
    }
  }
  return out;
}

export function findByPath(vbriefPath: string, logPath: string): Record<string, unknown>[] {
  return readAll(logPath).filter((e) => e.vbrief_path === vbriefPath);
}

export function latestForPath(
  vbriefPath: string,
  action: string | null,
  logPath: string,
): Record<string, unknown> | null {
  let rows = findByPath(vbriefPath, logPath);
  if (action !== null) {
    rows = rows.filter((r) => r.action === action);
  }
  if (rows.length === 0) {
    return null;
  }
  rows.sort((a, b) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")));
  return rows[rows.length - 1] ?? null;
}

export { utcNowIso as auditUtcNowIso };
