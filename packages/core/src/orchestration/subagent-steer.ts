/**
 * Parent-to-child steer inbox (#4286). Distinct from heartbeat liveness JSON.
 *
 * Heartbeat remains child-owned at `.deft-scratch/subagent-status/<agent-id>.json`.
 * Steer lives beside it at `.deft-scratch/subagent-steer/<agent-id>.json` so
 * `sweepScratchDirs` (top-level heartbeat files only) never treats inbox JSON
 * as a malformed heartbeat / REDISPATCH_OK.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { parseIso8601Utc, recordOk, sweepScratchDirs } from "./subagent-monitor.js";

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

/** Filesystem-safe agent slug: no path separators, no reserved ack/steer/firstseen suffixes. */
export function isSafeAgentId(agentId: string): boolean {
  if (typeof agentId !== "string" || agentId.length === 0 || agentId.length > 128) {
    return false;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(agentId)) {
    return false;
  }
  if (agentId.includes("..")) {
    return false;
  }
  if (agentId.endsWith(".ack") || agentId.endsWith(".steer") || agentId.endsWith(".firstseen")) {
    return false;
  }
  return true;
}

export function requireSafeAgentId(agentId: string): string {
  if (!isSafeAgentId(agentId)) {
    throw new Error(
      `agent_id is not a filesystem-safe slug: ${JSON.stringify(agentId)} (no path separators, no trailing .ack/.steer)`,
    );
  }
  return agentId;
}

export function steerInboxPath(steerDir: string, agentId: string): string {
  return join(steerDir, `${requireSafeAgentId(agentId)}.json`);
}

export function steerAckPath(steerDir: string, agentId: string): string {
  return join(steerDir, `${requireSafeAgentId(agentId)}.ack.json`);
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
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpName = `.${basename(filePath)}.${randomUUID()}.tmp`;
  containedWrite({
    root: dir,
    target: tmpName,
    data: `${JSON.stringify(payload, null, 2)}\n`,
    mode: "create",
    mkdir: true,
  });
  renameSync(join(dir, tmpName), filePath);
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
    const owner = options.occupancyOwnerId?.trim() ?? "";
    if (owner.length === 0) {
      return "occupancy-owner requires occupancyOwnerId";
    }
    if (owner !== trimmed) {
      return `occupancy-owner writer_id ${JSON.stringify(trimmed)} does not match occupancy owner ${JSON.stringify(owner)}`;
    }
  }
  if (writerKind === "dispatching-parent") {
    const parent = options.parentId?.trim() ?? "";
    if (parent.length === 0) {
      return "dispatching-parent requires parentId";
    }
    if (parent !== trimmed) {
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
  return { applied: true, reason: "applied", record: parsed.record, failures: [] };
}

/** Write apply-once ack after the child has acted on the steer text. */
export function ackSteer(
  steerDir: string,
  agentId: string,
  steerId: string,
  now: Date = new Date(),
): SteerAckRecord {
  const ackRecord: SteerAckRecord = {
    schema: STEER_ACK_SCHEMA,
    agent_id: requireSafeAgentId(agentId),
    steer_id: steerId,
    acked_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  atomicWriteJson(steerAckPath(steerDir, agentId), ackRecord);
  return ackRecord;
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
    .filter(
      (name) =>
        name.endsWith(".json") && !name.endsWith(".ack.json") && !name.endsWith(".firstseen.json"),
    )
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
  if (sweep.pending.length === 0 && sweep.parse_failures.length === 0) {
    lines.push("verify_subagent_steer: no unread steer");
    return lines.join("\n");
  }
  lines.push("STEER_PENDING: unread parent-steer inbox (not missing heartbeat)");
  lines.push("This is a parent-visible unread flag. It does not authorize takeover.");
  if (sweep.parse_failures.length > 0) {
    lines.push("  Malformed inbox (instruction not accepted):");
    for (const fail of sweep.parse_failures) {
      lines.push(`    ${fail}`);
    }
  }
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

/** Status-request kinds that can clear pre-cancel branch (a) (#5278). */
export const STATUS_STEER_KINDS = ["note", "correction"] as const;
export type StatusSteerKind = (typeof STATUS_STEER_KINDS)[number];

export const FIRST_SEEN_SCHEMA = "deft.subagent.steer-firstseen.v1";
export const DEFAULT_PRE_CANCEL_OBSERVED_WINDOW_SECONDS = 3 * 60;
export const DEFAULT_PRE_CANCEL_STARTUP_GRACE_SECONDS = 3 * 60;
/** Forward-only written_at skew vs first-seen (PA-18); no behind half. */
export const DEFAULT_PRE_CANCEL_FORWARD_SKEW_SECONDS = 60 * 1;
export const APPROACH1_ARM_STARTUP_HALT = "approach1-arm-startup" as const;
export const DEFAULT_APPROACH1_ARM_STARTUP_SECONDS = 3 * 60;

export const EXIT_PRE_CANCEL_OK = 0 * 1;
export const EXIT_PRE_CANCEL_REFUSED = 1 * 1;
export const EXIT_PRE_CANCEL_CONFIG = 2 * 1;

export function defaultFirstSeenDir(cwd: string = process.cwd()): string {
  return join(cwd, ".deft-scratch", "subagent-steer-firstseen");
}

export function isStatusSteerKind(value: unknown): value is StatusSteerKind {
  return typeof value === "string" && (STATUS_STEER_KINDS as readonly string[]).includes(value);
}

export interface FirstSeenRecord {
  schema: typeof FIRST_SEEN_SCHEMA;
  agent_id: string;
  steer_id: string;
  first_seen_at: string;
  canceller_id: string;
}

export function firstSeenPath(firstSeenDir: string, agentId: string, steerId: string): string {
  const safeAgent = requireSafeAgentId(agentId);
  const sanitized = steerId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  // Empty-after-sanitize uses a stable stem (returned-path filter; no throw-site).
  const safeSteer = sanitized.length > 0 ? sanitized : "_empty";
  return join(firstSeenDir, `${safeAgent}.${safeSteer}.json`);
}

/** Persist first-seen only when absent; never rewrite an existing stamp. */
export function readOrCreateFirstSeen(
  firstSeenDir: string,
  input: {
    agentId: string;
    steerId: string;
    cancellerId: string;
    now?: Date;
  },
): FirstSeenRecord {
  const path = firstSeenPath(firstSeenDir, input.agentId, input.steerId);
  if (existsSync(path)) {
    const failures: string[] = [];
    const obj = readJsonObject(path, failures);
    if (
      obj !== null &&
      obj.schema === FIRST_SEEN_SCHEMA &&
      typeof obj.agent_id === "string" &&
      typeof obj.steer_id === "string" &&
      typeof obj.first_seen_at === "string" &&
      typeof obj.canceller_id === "string" &&
      parseIso8601Utc(obj.first_seen_at) !== null
    ) {
      return {
        schema: FIRST_SEEN_SCHEMA,
        agent_id: obj.agent_id,
        steer_id: obj.steer_id,
        first_seen_at: obj.first_seen_at,
        canceller_id: obj.canceller_id,
      };
    }
  }
  const now = input.now ?? new Date();
  const record: FirstSeenRecord = {
    schema: FIRST_SEEN_SCHEMA,
    agent_id: requireSafeAgentId(input.agentId),
    steer_id: input.steerId,
    first_seen_at: formatNowIso(now),
    canceller_id: input.cancellerId.trim(),
  };
  atomicWriteJson(path, record);
  return record;
}

export type PreCancelClearReason =
  | "steer-acked"
  | "steer-observed-window"
  | "heartbeat-stale-or-missing-after-first"
  | "heartbeat-grace-expired-missing"
  | "force";

export type PreCancelRefuseReason =
  | "parse_failures"
  | "no-matching-status-steer"
  | "writer-mismatch"
  | "forward-skew"
  | "observed-window-incomplete"
  | "heartbeat-within-grace"
  | "heartbeat-fresh"
  | "heartbeat-malformed"
  | "identity-mismatch"
  | "missing-agent"
  | "missing-canceller"
  | "missing-dest"
  | "config";

export interface EvaluatePreCancelInput {
  agentId: string;
  cancellerId: string;
  steerDir: string;
  firstSeenDir: string;
  scratchDir: string;
  force?: boolean;
  forceReason?: string;
  now?: Date;
  observedWindowSeconds?: number;
  forwardSkewSeconds?: number;
  startupGraceSeconds?: number;
  /** DeliveryAttemptRecord.startedAt for grace path (b). */
  dispatchStartedAt?: string | null;
  thresholdMinutes?: number;
  /** Current attempt worker / incarnation; refuse if mismatched. */
  expectedWorkerId?: string | null;
}

export interface PreCancelVerdict {
  ok: boolean;
  exitCode:
    | typeof EXIT_PRE_CANCEL_OK
    | typeof EXIT_PRE_CANCEL_REFUSED
    | typeof EXIT_PRE_CANCEL_CONFIG;
  clear_reason: PreCancelClearReason | null;
  refuse_reason: PreCancelRefuseReason | null;
  message: string;
  agent_id: string;
  canceller_id: string;
  first_seen_at: string | null;
  matching_steer_id: string | null;
  json: Record<string, unknown>;
}

function agentParseFailures(sweep: SteerPendingSweep, agentId: string): string[] {
  const needle = `${agentId}.json`;
  return sweep.parse_failures.filter((f) => f.includes(needle) || f.includes(`${agentId}:`));
}

function findAckedStatusSteer(
  steerDir: string,
  agentId: string,
  cancellerId: string,
  now: Date,
): SteerRecord | null {
  const inbox = steerInboxPath(steerDir, agentId);
  if (!existsSync(inbox)) {
    return null;
  }
  const parsed = parseSteerFile(inbox);
  if (parsed.record === null) {
    return null;
  }
  const record = parsed.record;
  if (!isStatusSteerKind(record.kind)) {
    return null;
  }
  if (record.writer_id.trim() !== cancellerId.trim()) {
    return null;
  }
  const expires = parseIso8601Utc(record.expires_at);
  if (expires !== null && expires.getTime() <= now.getTime()) {
    return null;
  }
  const ack = parseSteerAckFile(steerAckPath(steerDir, agentId));
  if (ack.record !== null && ack.record.steer_id === record.steer_id) {
    return record;
  }
  return null;
}

function evaluateHeartbeatBranch(
  input: EvaluatePreCancelInput,
  now: Date,
): { clear: PreCancelClearReason | null; refuse: PreCancelRefuseReason | null; detail: string } {
  const graceSeconds = input.startupGraceSeconds ?? DEFAULT_PRE_CANCEL_STARTUP_GRACE_SECONDS;
  const thresholdMinutes = input.thresholdMinutes ?? 30;
  const scratchDir = input.scratchDir;
  const agentId = input.agentId;

  if (!existsSync(scratchDir)) {
    const started = input.dispatchStartedAt ? parseIso8601Utc(input.dispatchStartedAt) : null;
    if (started === null) {
      return {
        clear: null,
        refuse: "heartbeat-within-grace",
        detail: "scratch dir missing and no dispatchStartedAt for grace path (b)",
      };
    }
    const elapsed = (now.getTime() - started.getTime()) / 1000;
    if (elapsed >= graceSeconds) {
      return {
        clear: "heartbeat-grace-expired-missing",
        refuse: null,
        detail: `no heartbeat after grace ${graceSeconds}s from dispatch`,
      };
    }
    return {
      clear: null,
      refuse: "heartbeat-within-grace",
      detail: `within startup grace (${Math.round(elapsed)}s < ${graceSeconds}s)`,
    };
  }

  const sweep = sweepScratchDirs([{ readPath: scratchDir, label: scratchDir }], {
    thresholdMinutes,
    now,
  });
  const rec = sweep.records.find((r) => r.agent_id === agentId);
  if (rec === undefined) {
    const started = input.dispatchStartedAt ? parseIso8601Utc(input.dispatchStartedAt) : null;
    if (started === null) {
      return {
        clear: null,
        refuse: "heartbeat-within-grace",
        detail: "required agent heartbeat missing and no dispatchStartedAt",
      };
    }
    const elapsed = (now.getTime() - started.getTime()) / 1000;
    if (elapsed >= graceSeconds) {
      return {
        clear: "heartbeat-grace-expired-missing",
        refuse: null,
        detail: `missing required agent after grace ${graceSeconds}s`,
      };
    }
    return {
      clear: null,
      refuse: "heartbeat-within-grace",
      detail: `missing heartbeat within grace (${Math.round(elapsed)}s < ${graceSeconds}s)`,
    };
  }

  if (rec.is_stale) {
    // First-seen-then-STALE (path b). Malformed-but-fresh must NOT clear.
    return {
      clear: "heartbeat-stale-or-missing-after-first",
      refuse: null,
      detail: "heartbeat STALE",
    };
  }
  if (!recordOk(rec)) {
    return {
      clear: null,
      refuse: "heartbeat-malformed",
      detail:
        "heartbeat fresh but unhealthy/parse-failed (e.g. invalid wait_kind); refuse cancel while child still reporting",
    };
  }

  return {
    clear: null,
    refuse: "heartbeat-fresh",
    detail: "heartbeat is fresh; status steer or --force required",
  };
}

/**
 * Fail-closed query-before-cancel gate (#5278 Prefer-A).
 * Exit 0 only via (a) status steer ack/observed window, (b) heartbeat STALE/missing
 * under documented grace, or (c) explicit --force with reason.
 */
export function evaluatePreCancel(input: EvaluatePreCancelInput): PreCancelVerdict {
  const agentId = input.agentId?.trim() ?? "";
  const cancellerId = input.cancellerId?.trim() ?? "";
  const baseJson = (): Record<string, unknown> => ({
    ok: false,
    agent_id: agentId,
    canceller_id: cancellerId,
    clear_reason: null,
    refuse_reason: null,
    first_seen_at: null,
    matching_steer_id: null,
  });

  const finish = (
    partial: Omit<
      PreCancelVerdict,
      "json" | "agent_id" | "canceller_id" | "matching_steer_id" | "first_seen_at"
    > & {
      matching_steer_id?: string | null;
      first_seen_at?: string | null;
    },
  ): PreCancelVerdict => {
    const matching = partial.matching_steer_id ?? null;
    const firstSeen = partial.first_seen_at ?? null;
    const json = {
      ...baseJson(),
      ok: partial.ok,
      clear_reason: partial.clear_reason,
      refuse_reason: partial.refuse_reason,
      first_seen_at: firstSeen,
      matching_steer_id: matching,
      message: partial.message,
      exit_code: partial.exitCode,
    };
    return {
      ok: partial.ok,
      exitCode: partial.exitCode,
      clear_reason: partial.clear_reason,
      refuse_reason: partial.refuse_reason,
      message: partial.message,
      agent_id: agentId,
      canceller_id: cancellerId,
      first_seen_at: firstSeen,
      matching_steer_id: matching,
      json,
    };
  };

  if (agentId.length === 0 || !isSafeAgentId(agentId)) {
    return finish({
      ok: false,
      exitCode: EXIT_PRE_CANCEL_CONFIG,
      clear_reason: null,
      refuse_reason: "missing-agent",
      message: "subagent:pre-cancel: --agent is required and must be a filesystem-safe slug",
    });
  }
  if (cancellerId.length === 0) {
    return finish({
      ok: false,
      exitCode: EXIT_PRE_CANCEL_CONFIG,
      clear_reason: null,
      refuse_reason: "missing-canceller",
      message: "subagent:pre-cancel: --canceller-id is required (writer_id / session identity)",
    });
  }
  if (
    input.steerDir.trim().length === 0 ||
    input.firstSeenDir.trim().length === 0 ||
    input.scratchDir.trim().length === 0
  ) {
    return finish({
      ok: false,
      exitCode: EXIT_PRE_CANCEL_CONFIG,
      clear_reason: null,
      refuse_reason: "missing-dest",
      message:
        "subagent:pre-cancel: dest-capable --steer-dir / --first-seen-dir / --scratch-dir (or --target-id) required; default-to-cwd alone is refuse-closed for linked-worktree children",
    });
  }

  if (
    input.expectedWorkerId !== undefined &&
    input.expectedWorkerId !== null &&
    input.expectedWorkerId.trim().length > 0 &&
    input.expectedWorkerId.trim() !== agentId
  ) {
    return finish({
      ok: false,
      exitCode: EXIT_PRE_CANCEL_REFUSED,
      clear_reason: null,
      refuse_reason: "identity-mismatch",
      message: `subagent:pre-cancel: agent ${JSON.stringify(agentId)} does not match current attempt worker ${JSON.stringify(input.expectedWorkerId)}`,
    });
  }

  if (input.force === true) {
    const reason = input.forceReason?.trim() ?? "";
    if (reason.length === 0) {
      return finish({
        ok: false,
        exitCode: EXIT_PRE_CANCEL_CONFIG,
        clear_reason: null,
        refuse_reason: "config",
        message: "subagent:pre-cancel: --force requires --reason",
      });
    }
    return finish({
      ok: true,
      exitCode: EXIT_PRE_CANCEL_OK,
      clear_reason: "force",
      refuse_reason: null,
      message: `subagent:pre-cancel: FORCE clear by ${cancellerId}: ${reason}`,
    });
  }

  const now = input.now ?? new Date();
  const observedWindow = input.observedWindowSeconds ?? DEFAULT_PRE_CANCEL_OBSERVED_WINDOW_SECONDS;
  const forwardSkew = input.forwardSkewSeconds ?? DEFAULT_PRE_CANCEL_FORWARD_SKEW_SECONDS;

  // Branch (a): status steer + ack OR observed first-seen window (P4 pending[] + ack path).
  const sweep = sweepSteerPending(input.steerDir, { now, agentIds: [agentId] });
  if (steerPendingConfigError(sweep)) {
    return finish({
      ok: false,
      exitCode: EXIT_PRE_CANCEL_CONFIG,
      clear_reason: null,
      refuse_reason: "config",
      message: `subagent:pre-cancel: steer sweep config error: ${sweep.sweep_errors.join("; ")}`,
    });
  }

  const parseFails = agentParseFailures(sweep, agentId);
  if (parseFails.length > 0) {
    return finish({
      ok: false,
      exitCode: EXIT_PRE_CANCEL_REFUSED,
      clear_reason: null,
      refuse_reason: "parse_failures",
      message: `subagent:pre-cancel: parse_failures keep gate red:\n  ${parseFails.join("\n  ")}`,
    });
  }

  const acked = findAckedStatusSteer(input.steerDir, agentId, cancellerId, now);
  if (acked !== null) {
    return finish({
      ok: true,
      exitCode: EXIT_PRE_CANCEL_OK,
      clear_reason: "steer-acked",
      refuse_reason: null,
      matching_steer_id: acked.steer_id,
      message: `subagent:pre-cancel: cleared via matching ack for steer_id=${acked.steer_id}`,
    });
  }

  const pendingMatch = sweep.pending.find(
    (p) =>
      p.agent_id === agentId && isStatusSteerKind(p.kind) && p.writer_id.trim() === cancellerId,
  );

  if (pendingMatch !== undefined) {
    const firstSeen = readOrCreateFirstSeen(input.firstSeenDir, {
      agentId,
      steerId: pendingMatch.steer_id,
      cancellerId,
      now,
    });
    const firstSeenAt = parseIso8601Utc(firstSeen.first_seen_at);
    const writtenAt = parseIso8601Utc(pendingMatch.written_at);
    if (firstSeenAt === null) {
      return finish({
        ok: false,
        exitCode: EXIT_PRE_CANCEL_CONFIG,
        clear_reason: null,
        refuse_reason: "config",
        message: "subagent:pre-cancel: first-seen timestamp unparseable",
        matching_steer_id: pendingMatch.steer_id,
        first_seen_at: firstSeen.first_seen_at,
      });
    }
    if (writtenAt !== null && writtenAt.getTime() - firstSeenAt.getTime() > forwardSkew * 1000) {
      return finish({
        ok: false,
        exitCode: EXIT_PRE_CANCEL_REFUSED,
        clear_reason: null,
        refuse_reason: "forward-skew",
        message: `subagent:pre-cancel: written_at is more than ${forwardSkew}s ahead of first-seen (forward skew refuse)`,
        matching_steer_id: pendingMatch.steer_id,
        first_seen_at: firstSeen.first_seen_at,
      });
    }
    const elapsed = (now.getTime() - firstSeenAt.getTime()) / 1000;
    if (elapsed + 1e-9 < observedWindow) {
      // Branch (b) remains OR with (a): STALE/missing heartbeat may clear while
      // the status-steer observed window is still incomplete (#5278 Greptile P1).
      const hbEarly = evaluateHeartbeatBranch(input, now);
      if (hbEarly.clear !== null) {
        return finish({
          ok: true,
          exitCode: EXIT_PRE_CANCEL_OK,
          clear_reason: hbEarly.clear,
          refuse_reason: null,
          matching_steer_id: pendingMatch.steer_id,
          first_seen_at: firstSeen.first_seen_at,
          message: `subagent:pre-cancel: cleared via heartbeat path during incomplete observed window — ${hbEarly.detail}`,
        });
      }
      return finish({
        ok: false,
        exitCode: EXIT_PRE_CANCEL_REFUSED,
        clear_reason: null,
        refuse_reason: "observed-window-incomplete",
        message: `subagent:pre-cancel: observed window incomplete (${elapsed.toFixed(1)}s < ${observedWindow}s from first-seen); wait or await ack`,
        matching_steer_id: pendingMatch.steer_id,
        first_seen_at: firstSeen.first_seen_at,
      });
    }
    return finish({
      ok: true,
      exitCode: EXIT_PRE_CANCEL_OK,
      clear_reason: "steer-observed-window",
      refuse_reason: null,
      matching_steer_id: pendingMatch.steer_id,
      first_seen_at: firstSeen.first_seen_at,
      message: `subagent:pre-cancel: cleared via observed window (${elapsed.toFixed(1)}s ≥ ${observedWindow}s) for steer_id=${pendingMatch.steer_id}`,
    });
  }

  if (sweep.pending.some((p) => p.agent_id === agentId)) {
    const hbForeign = evaluateHeartbeatBranch(input, now);
    if (hbForeign.clear !== null) {
      return finish({
        ok: true,
        exitCode: EXIT_PRE_CANCEL_OK,
        clear_reason: hbForeign.clear,
        refuse_reason: null,
        message: `subagent:pre-cancel: cleared via heartbeat path with non-canceller pending steer — ${hbForeign.detail}`,
      });
    }
    return finish({
      ok: false,
      exitCode: EXIT_PRE_CANCEL_REFUSED,
      clear_reason: null,
      refuse_reason: "writer-mismatch",
      message:
        "subagent:pre-cancel: pending steer is not a canceller-authored status-request (kind note|correction + writer_id match)",
    });
  }

  // Branch (b): heartbeat STALE/missing under grace rules.
  const hb = evaluateHeartbeatBranch(input, now);
  if (hb.clear !== null) {
    return finish({
      ok: true,
      exitCode: EXIT_PRE_CANCEL_OK,
      clear_reason: hb.clear,
      refuse_reason: null,
      message: `subagent:pre-cancel: cleared via heartbeat path — ${hb.detail}`,
    });
  }

  return finish({
    ok: false,
    exitCode: EXIT_PRE_CANCEL_REFUSED,
    clear_reason: null,
    refuse_reason: hb.refuse ?? "no-matching-status-steer",
    message: `subagent:pre-cancel: refused — ${hb.detail}; write status steer (note|correction) via subagent:steer, wait observed window/ack, or --force --reason`,
  });
}

export interface Approach1ArmStartupInput {
  dispatchStartedAt: string;
  probeReady: boolean;
  now?: Date;
  allowanceSeconds?: number;
}

export interface Approach1ArmStartupVerdict {
  halt: boolean;
  halt_class: typeof APPROACH1_ARM_STARTUP_HALT | null;
  elapsed_seconds: number | null;
  message: string;
}

/** Named Approach 1 arm-probe halt after startup allowance (#5278 P3). */
export function evaluateApproach1ArmStartup(
  input: Approach1ArmStartupInput,
): Approach1ArmStartupVerdict {
  const started = parseIso8601Utc(input.dispatchStartedAt);
  if (started === null) {
    return {
      halt: false,
      halt_class: null,
      elapsed_seconds: null,
      message: "approach1-arm-startup: dispatchStartedAt unparseable; cannot arm halt clock",
    };
  }
  const now = input.now ?? new Date();
  const allowance = input.allowanceSeconds ?? DEFAULT_APPROACH1_ARM_STARTUP_SECONDS;
  const elapsed = (now.getTime() - started.getTime()) / 1000;
  if (input.probeReady) {
    return {
      halt: false,
      halt_class: null,
      elapsed_seconds: elapsed,
      message: "approach1-arm-startup: merge-path arm probe ready",
    };
  }
  if (elapsed < allowance) {
    return {
      halt: false,
      halt_class: null,
      elapsed_seconds: elapsed,
      message: `approach1-arm-startup: within startup allowance (${elapsed.toFixed(1)}s < ${allowance}s)`,
    };
  }
  return {
    halt: true,
    halt_class: APPROACH1_ARM_STARTUP_HALT,
    elapsed_seconds: elapsed,
    message: `approach1-arm-startup: halt — merge-path arm probe still red after ${elapsed.toFixed(1)}s (allowance ${allowance}s from DeliveryAttemptRecord.startedAt); route into subagent:pre-cancel; do not auto re-spawn`,
  };
}
