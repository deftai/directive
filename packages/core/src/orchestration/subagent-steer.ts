/**
 * Parent-to-child steer inbox (#4286). Distinct from heartbeat liveness JSON.
 *
 * Heartbeat remains child-owned at `.deft-scratch/subagent-status/<agent-id>.json`.
 * Steer lives beside it at `.deft-scratch/subagent-steer/<agent-id>.json` so
 * `sweepScratchDirs` (top-level heartbeat files only) never treats inbox JSON
 * as a malformed heartbeat / REDISPATCH_OK.
 */
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseIso8601Utc } from "./subagent-monitor.js";

export const STEER_SCHEMA = "deft.subagent.steer.v1";
export const STEER_ACK_SCHEMA = "deft.subagent.steer-ack.v1";
/** Prefix used by the heartbeat sweep to skip stray steer JSON in the liveness dir. */
export const STEER_SCHEMA_PREFIX = "deft.subagent.steer";

export const STEER_KINDS = ["constraint", "correction", "halt", "note"] as const;
export type SteerKind = (typeof STEER_KINDS)[number];

export const STEER_WRITER_KINDS = ["occupancy-owner", "dispatching-parent"] as const;
export type SteerWriterKind = (typeof STEER_WRITER_KINDS)[number];

export const STEER_TEXT_MAX_CHARS = 2000;
export const DEFAULT_STEER_TTL_SECONDS = 30 * 60;

export const EXIT_STEER_OK = 0;
export const EXIT_STEER_PENDING = 1;
export const EXIT_STEER_CONFIG = 2;

export function defaultSteerDir(cwd: string = process.cwd()): string {
  return join(cwd, ".deft-scratch", "subagent-steer");
}

export function steerInboxPath(steerDir: string, agentId: string): string {
  return join(steerDir, `${agentId}.json`);
}

export function steerAckPath(steerDir: string, agentId: string): string {
  return join(steerDir, `${agentId}.ack.json`);
}

export interface SteerRecord {
  schema: typeof STEER_SCHEMA;
  agent_id: string;
  steer_id: string;
  written_at: string;
  expires_at: string;
  writer_kind: SteerWriterKind;
  writer_id: string;
  kind: SteerKind;
  text: string;
}

export interface SteerAckRecord {
  schema: typeof STEER_ACK_SCHEMA;
  agent_id: string;
  steer_id: string;
  acked_at: string;
}

export interface ParsedSteer {
  path: string;
  record: SteerRecord | null;
  failures: string[];
}

export interface ParsedSteerAck {
  path: string;
  record: SteerAckRecord | null;
  failures: string[];
}

export interface SteerPending {
  agent_id: string;
  steer_id: string;
  written_at: string;
  expires_at: string;
  writer_kind: SteerWriterKind;
  writer_id: string;
  kind: SteerKind;
  age_seconds: number | null;
  path: string;
}

function isSteerKind(value: unknown): value is SteerKind {
  return typeof value === "string" && (STEER_KINDS as readonly string[]).includes(value);
}

function isWriterKind(value: unknown): value is SteerWriterKind {
  return typeof value === "string" && (STEER_WRITER_KINDS as readonly string[]).includes(value);
}

function requireString(
  obj: Record<string, unknown>,
  field: string,
  failures: string[],
): string | null {
  if (!(field in obj)) {
    failures.push(`missing required field: ${field}`);
    return null;
  }
  if (typeof obj[field] !== "string") {
    failures.push(`${field} must be a string`);
    return null;
  }
  const value = obj[field] as string;
  if (value.trim().length === 0) {
    failures.push(`${field} must be non-empty`);
    return null;
  }
  return value;
}

function atomicWriteJson(filePath: string, payload: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(tmp, filePath);
}

function readJsonObject(filePath: string, failures: string[]): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err: unknown) {
    failures.push(`unreadable: ${String((err as Error).message ?? err)}`);
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch (err: unknown) {
    const msg = err instanceof SyntaxError ? err.message : String(err);
    failures.push(`malformed JSON: ${msg}`);
    return null;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    failures.push("top-level must be a JSON object");
    return null;
  }
  return payload as Record<string, unknown>;
}

/** Parse one closed-schema steer inbox file. Never throws. */
export function parseSteerFile(filePath: string): ParsedSteer {
  const failures: string[] = [];
  const obj = readJsonObject(filePath, failures);
  if (obj === null) {
    return { path: filePath, record: null, failures };
  }

  if (obj.schema !== STEER_SCHEMA) {
    failures.push(
      `schema must be ${JSON.stringify(STEER_SCHEMA)}, got ${JSON.stringify(obj.schema)}`,
    );
  }

  const agentId = requireString(obj, "agent_id", failures);
  const steerId = requireString(obj, "steer_id", failures);
  const writtenAt = requireString(obj, "written_at", failures);
  const expiresAt = requireString(obj, "expires_at", failures);
  const writerId = requireString(obj, "writer_id", failures);
  const text = typeof obj.text === "string" ? obj.text : null;
  if (typeof obj.text !== "string") {
    failures.push("text must be a string");
  } else if (obj.text.trim().length === 0) {
    failures.push("text must be non-empty");
  } else if (obj.text.length > STEER_TEXT_MAX_CHARS) {
    failures.push(`text exceeds ${STEER_TEXT_MAX_CHARS} chars`);
  }

  if (!isWriterKind(obj.writer_kind)) {
    failures.push(
      `writer_kind must be one of ${STEER_WRITER_KINDS.join(", ")}; got ${JSON.stringify(obj.writer_kind)}`,
    );
  }
  if (!isSteerKind(obj.kind)) {
    failures.push(`kind must be one of ${STEER_KINDS.join(", ")}; got ${JSON.stringify(obj.kind)}`);
  }

  const expectedId = basename(filePath, ".json");
  if (agentId !== null && agentId !== expectedId) {
    failures.push(
      `agent_id mismatch: file is '${expectedId}.json' but payload has agent_id=${JSON.stringify(agentId)}`,
    );
  }

  if (writtenAt !== null && parseIso8601Utc(writtenAt) === null) {
    failures.push("written_at not ISO-8601 UTC (must end in 'Z' or '+00:00')");
  }
  if (expiresAt !== null && parseIso8601Utc(expiresAt) === null) {
    failures.push("expires_at not ISO-8601 UTC (must end in 'Z' or '+00:00')");
  }

  if (failures.length > 0 || agentId === null || steerId === null || writtenAt === null) {
    return { path: filePath, record: null, failures };
  }
  if (expiresAt === null || writerId === null || text === null) {
    return { path: filePath, record: null, failures };
  }
  if (!isWriterKind(obj.writer_kind) || !isSteerKind(obj.kind)) {
    return { path: filePath, record: null, failures };
  }

  return {
    path: filePath,
    record: {
      schema: STEER_SCHEMA,
      agent_id: agentId,
      steer_id: steerId,
      written_at: writtenAt,
      expires_at: expiresAt,
      writer_kind: obj.writer_kind,
      writer_id: writerId,
      kind: obj.kind,
      text,
    },
    failures: [],
  };
}

/** Parse one apply-once ack file. Never throws. */
export function parseSteerAckFile(filePath: string): ParsedSteerAck {
  const failures: string[] = [];
  if (!existsSync(filePath)) {
    return { path: filePath, record: null, failures };
  }
  const obj = readJsonObject(filePath, failures);
  if (obj === null) {
    return { path: filePath, record: null, failures };
  }
  if (obj.schema !== STEER_ACK_SCHEMA) {
    failures.push(
      `schema must be ${JSON.stringify(STEER_ACK_SCHEMA)}, got ${JSON.stringify(obj.schema)}`,
    );
  }
  const agentId = requireString(obj, "agent_id", failures);
  const steerId = requireString(obj, "steer_id", failures);
  const ackedAt = requireString(obj, "acked_at", failures);
  if (ackedAt !== null && parseIso8601Utc(ackedAt) === null) {
    failures.push("acked_at not ISO-8601 UTC (must end in 'Z' or '+00:00')");
  }
  if (failures.length > 0 || agentId === null || steerId === null || ackedAt === null) {
    return { path: filePath, record: null, failures };
  }
  return {
    path: filePath,
    record: {
      schema: STEER_ACK_SCHEMA,
      agent_id: agentId,
      steer_id: steerId,
      acked_at: ackedAt,
    },
    failures: [],
  };
}

export interface WriteSteerInput {
  agentId: string;
  writerKind: SteerWriterKind;
  writerId: string;
  kind: SteerKind;
  text: string;
  steerId?: string;
  writtenAt?: Date;
  ttlSeconds?: number;
  occupancyOwnerId?: string | null;
  parentId?: string | null;
}

export function assertSteerWriter(
  writerKind: SteerWriterKind,
  writerId: string,
  options: { occupancyOwnerId?: string | null; parentId?: string | null } = {},
): string | null {
  const trimmed = writerId.trim();
  if (trimmed.length === 0) {
    return "writer_id must be non-empty";
  }
  if (writerKind === "occupancy-owner") {
    const owner = options.occupancyOwnerId?.trim();
    if (owner !== undefined && owner.length > 0 && owner !== trimmed) {
      return `occupancy-owner writer_id ${JSON.stringify(trimmed)} does not match occupancy owner ${JSON.stringify(owner)}`;
    }
  }
  if (writerKind === "dispatching-parent") {
    const parent = options.parentId?.trim();
    if (parent !== undefined && parent.length > 0 && parent !== trimmed) {
      return `dispatching-parent writer_id ${JSON.stringify(trimmed)} does not match parent_id ${JSON.stringify(parent)}`;
    }
  }
  return null;
}

export function writeSteer(steerDir: string, input: WriteSteerInput): SteerRecord {
  const text = input.text;
  if (text.trim().length === 0) {
    throw new Error("steer text must be non-empty");
  }
  if (text.length > STEER_TEXT_MAX_CHARS) {
    throw new Error(`steer text exceeds ${STEER_TEXT_MAX_CHARS} chars`);
  }
  const writerError = assertSteerWriter(input.writerKind, input.writerId, {
    occupancyOwnerId: input.occupancyOwnerId,
    parentId: input.parentId,
  });
  if (writerError !== null) {
    throw new Error(writerError);
  }
  const writtenAt = input.writtenAt ?? new Date();
  const ttl = input.ttlSeconds ?? DEFAULT_STEER_TTL_SECONDS;
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new Error("ttlSeconds must be positive");
  }
  const expires = new Date(writtenAt.getTime() + ttl * 1000);
  const record: SteerRecord = {
    schema: STEER_SCHEMA,
    agent_id: input.agentId,
    steer_id: input.steerId ?? randomUUID(),
    written_at: writtenAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
    expires_at: expires.toISOString().replace(/\.\d{3}Z$/, "Z"),
    writer_kind: input.writerKind,
    writer_id: input.writerId.trim(),
    kind: input.kind,
    text,
  };
  atomicWriteJson(steerInboxPath(steerDir, input.agentId), record);
  return record;
}

export interface ApplyUnreadResult {
  applied: boolean;
  reason: "applied" | "no-inbox" | "expired" | "already-acked" | "invalid" | "writer-refused";
  record: SteerRecord | null;
  failures: string[];
}

export function applyUnreadSteer(
  steerDir: string,
  agentId: string,
  options: {
    now?: Date;
    occupancyOwnerId?: string | null;
    parentId?: string | null;
  } = {},
): ApplyUnreadResult {
  const now = options.now ?? new Date();
  const inbox = steerInboxPath(steerDir, agentId);
  if (!existsSync(inbox)) {
    return { applied: false, reason: "no-inbox", record: null, failures: [] };
  }
  const parsed = parseSteerFile(inbox);
  if (parsed.record === null) {
    return { applied: false, reason: "invalid", record: null, failures: parsed.failures };
  }
  const writerError = assertSteerWriter(parsed.record.writer_kind, parsed.record.writer_id, {
    occupancyOwnerId: options.occupancyOwnerId,
    parentId: options.parentId,
  });
  if (writerError !== null) {
    return {
      applied: false,
      reason: "writer-refused",
      record: parsed.record,
      failures: [writerError],
    };
  }
  const expires = parseIso8601Utc(parsed.record.expires_at);
  if (expires !== null && expires.getTime() <= now.getTime()) {
    return { applied: false, reason: "expired", record: parsed.record, failures: [] };
  }
  const ack = parseSteerAckFile(steerAckPath(steerDir, agentId));
  if (ack.record !== null && ack.record.steer_id === parsed.record.steer_id) {
    return { applied: false, reason: "already-acked", record: parsed.record, failures: [] };
  }
  const ackRecord: SteerAckRecord = {
    schema: STEER_ACK_SCHEMA,
    agent_id: agentId,
    steer_id: parsed.record.steer_id,
    acked_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  atomicWriteJson(steerAckPath(steerDir, agentId), ackRecord);
  return { applied: true, reason: "applied", record: parsed.record, failures: [] };
}

export interface SteerPendingSweep {
  steer_dir: string;
  now_iso: string;
  pending: SteerPending[];
  parse_failures: string[];
  sweep_errors: string[];
}

function formatNowIso(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function inboxFilenames(steerDir: string): string[] {
  return readdirSync(steerDir)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".ack.json"))
    .sort();
}

/** Parent-visible unread flag. Expired or acked inbox is not pending. */
export function sweepSteerPending(
  steerDir: string,
  options: { now?: Date; agentIds?: string[] } = {},
): SteerPendingSweep {
  const now = options.now ?? new Date();
  const result: SteerPendingSweep = {
    steer_dir: steerDir,
    now_iso: formatNowIso(now),
    pending: [],
    parse_failures: [],
    sweep_errors: [],
  };

  if (!existsSync(steerDir)) {
    return result;
  }
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(steerDir);
  } catch (err: unknown) {
    result.sweep_errors.push(`steer dir unreadable: ${String((err as Error).message ?? err)}`);
    return result;
  }
  if (!stat.isDirectory()) {
    result.sweep_errors.push(`steer path is not a directory: ${steerDir}`);
    return result;
  }

  let names: string[];
  try {
    names = inboxFilenames(steerDir);
  } catch (err: unknown) {
    result.sweep_errors.push(`steer dir unreadable: ${String((err as Error).message ?? err)}`);
    return result;
  }

  const wanted = options.agentIds !== undefined ? new Set(options.agentIds) : null;
  for (const name of names) {
    const agentId = basename(name, ".json");
    if (wanted !== null && !wanted.has(agentId)) {
      continue;
    }
    const path = join(steerDir, name);
    try {
      if (!statSync(path).isFile()) {
        continue;
      }
    } catch {
      continue;
    }
    const parsed = parseSteerFile(path);
    if (parsed.record === null) {
      result.parse_failures.push(`${path}: ${parsed.failures.join("; ")}`);
      continue;
    }
    const expires = parseIso8601Utc(parsed.record.expires_at);
    if (expires !== null && expires.getTime() <= now.getTime()) {
      continue;
    }
    const ack = parseSteerAckFile(steerAckPath(steerDir, parsed.record.agent_id));
    if (ack.record !== null && ack.record.steer_id === parsed.record.steer_id) {
      continue;
    }
    const written = parseIso8601Utc(parsed.record.written_at);
    result.pending.push({
      agent_id: parsed.record.agent_id,
      steer_id: parsed.record.steer_id,
      written_at: parsed.record.written_at,
      expires_at: parsed.record.expires_at,
      writer_kind: parsed.record.writer_kind,
      writer_id: parsed.record.writer_id,
      kind: parsed.record.kind,
      age_seconds: written === null ? null : (now.getTime() - written.getTime()) / 1000,
      path,
    });
  }

  return result;
}

export function steerPendingConfigError(sweep: SteerPendingSweep): boolean {
  return sweep.sweep_errors.length > 0 && sweep.pending.length === 0;
}

export function renderSteerPendingText(sweep: SteerPendingSweep): string {
  const lines: string[] = [];
  if (sweep.sweep_errors.length > 0) {
    lines.push("verify_subagent_steer: config error");
    for (const err of sweep.sweep_errors) {
      lines.push(`  ${err}`);
    }
    return lines.join("\n");
  }
  if (sweep.pending.length === 0) {
    lines.push("verify_subagent_steer: no unread steer");
    if (sweep.parse_failures.length > 0) {
      lines.push("  Parse failures (not pending; not a liveness takeover):");
      for (const fail of sweep.parse_failures) {
        lines.push(`    ${fail}`);
      }
    }
    return lines.join("\n");
  }
  lines.push("STEER_PENDING: unread parent-steer inbox (not missing heartbeat)");
  lines.push("This is a parent-visible unread flag. It does not authorize takeover.");
  for (const item of sweep.pending) {
    const age =
      item.age_seconds === null
        ? "unknown"
        : item.age_seconds < 60
          ? `${Math.round(item.age_seconds)}s`
          : `${(item.age_seconds / 60).toFixed(1)}m`;
    lines.push(
      `  ${item.agent_id} steer_id=${item.steer_id} kind=${item.kind} writer=${item.writer_kind}:${item.writer_id} age=${age}`,
    );
  }
  return lines.join("\n");
}
