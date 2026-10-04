/**
 * Host kill attestation (#5281 Prefer-A Bound).
 *
 * Equivalent attestation until #5278 `subagent:pre-cancel` is on the delivery
 * tip. Deny-class PreToolUse reads this artifact (or a tip pre-cancel seam)
 * before allowing `kill_command_or_subagent` on a still-running child.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { parseIso8601Utc } from "./subagent-monitor.js";

export const KILL_ATTESTATION_SCHEMA = "deft.subagent.kill-attestation.v1";
export const KILL_ATTESTATION_KINDS = ["note", "correction", "force"] as const;
export type KillAttestationKind = (typeof KILL_ATTESTATION_KINDS)[number];

/** S1 numeric TTL pin (short; distinct from steer 30m default). */
export const DEFAULT_KILL_ATTESTATION_TTL_SECONDS = Number("600");

export type KillHostStatus = "running" | "terminal" | "unknown";

export type KillAttestationClearReason =
  | "pre-cancel-green"
  | "equivalent-attestation"
  | "force"
  | "host-terminal";

export type KillAttestationRefuseReason =
  | "missing-target"
  | "missing-attestation"
  | "expired-attestation"
  | "invalid-attestation"
  | "writer-mismatch"
  | "force-missing-reason"
  | "still-running-unattested"
  | "status-unknown-unattested";

export interface KillAttestationRecord {
  schema: typeof KILL_ATTESTATION_SCHEMA;
  agent_id: string;
  writer_id: string;
  kind: KillAttestationKind;
  created_at: string;
  expires_at: string;
  reason?: string;
}

export interface WriteKillAttestationInput {
  agentId: string;
  writerId: string;
  kind: KillAttestationKind;
  reason?: string;
  createdAt?: Date;
  ttlSeconds?: number;
}

export interface EvaluateKillAttestationInput {
  agentId: string;
  /** Killer identity; must match attestation.writer_id for note/correction. */
  writerId: string;
  attestationDir: string;
  force?: boolean;
  forceReason?: string | null;
  /** Host-reported task status oracle (not heartbeat STALE/REDISPATCH_OK). */
  hostStatus?: KillHostStatus;
  now?: Date;
  /**
   * Tip seam: when #5278 `evaluatePreCancel` is present, inject it.
   * Return true only for exit-0 green.
   */
  evaluatePreCancelGreen?: () => boolean;
}

export interface KillAttestationVerdict {
  ok: boolean;
  clear_reason: KillAttestationClearReason | null;
  refuse_reason: KillAttestationRefuseReason | null;
  message: string;
  agent_id: string;
  writer_id: string;
  printed_force_reason: string | null;
  attestation: KillAttestationRecord | null;
}

export function defaultKillAttestationDir(cwd: string = process.cwd()): string {
  return join(cwd, ".deft-scratch", "subagent-kill-attestation");
}

export type KillAttestationSlugResult = { ok: true; slug: string } | { ok: false; error: string };

/** Path slug for attestation files; preserves readable ids without path separators. */
export function killAttestationSlug(agentId: string): KillAttestationSlugResult {
  const trimmed = agentId.trim();
  if (trimmed.length === 0 || trimmed.length > 200) {
    return {
      ok: false,
      error: `agent_id length out of range for kill attestation: ${trimmed.length}`,
    };
  }
  if (trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\")) {
    return {
      ok: false,
      error: `agent_id must not contain path separators: ${JSON.stringify(trimmed)}`,
    };
  }
  const slug = trimmed.replace(/[^A-Za-z0-9._-]+/g, "_");
  if (slug.length === 0) {
    return { ok: false, error: `agent_id sanitizes to empty slug: ${JSON.stringify(trimmed)}` };
  }
  return { ok: true, slug };
}

export function killAttestationPath(attestationDir: string, agentId: string): string | null {
  const slug = killAttestationSlug(agentId);
  if (!slug.ok) return null;
  return join(attestationDir, `${slug.slug}.json`);
}

function isKillAttestationKind(value: unknown): value is KillAttestationKind {
  return typeof value === "string" && (KILL_ATTESTATION_KINDS as readonly string[]).includes(value);
}

function formatNowIso(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
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

export type WriteKillAttestationResult =
  | { ok: true; record: KillAttestationRecord }
  | { ok: false; error: string };

export function writeKillAttestation(
  attestationDir: string,
  input: WriteKillAttestationInput,
): WriteKillAttestationResult {
  const writerId = input.writerId.trim();
  if (writerId.length === 0) {
    return { ok: false, error: "writer_id must be non-empty" };
  }
  if (input.kind === "force") {
    const reason = input.reason?.trim() ?? "";
    if (reason.length === 0) {
      return { ok: false, error: "kind:force requires a non-empty reason" };
    }
  }
  const createdAt = input.createdAt ?? new Date();
  const ttl = input.ttlSeconds ?? DEFAULT_KILL_ATTESTATION_TTL_SECONDS;
  if (!Number.isFinite(ttl) || ttl <= 0) {
    return { ok: false, error: "ttlSeconds must be positive" };
  }
  const target = killAttestationPath(attestationDir, input.agentId);
  if (target === null) {
    const slug = killAttestationSlug(input.agentId);
    return { ok: false, error: slug.ok ? "invalid agent_id" : slug.error };
  }
  const expires = new Date(createdAt.getTime() + ttl * 1000);
  const record: KillAttestationRecord = {
    schema: KILL_ATTESTATION_SCHEMA,
    agent_id: input.agentId.trim(),
    writer_id: writerId,
    kind: input.kind,
    created_at: formatNowIso(createdAt),
    expires_at: formatNowIso(expires),
  };
  const reason = input.reason?.trim();
  if (reason !== undefined && reason.length > 0) {
    record.reason = reason;
  }
  atomicWriteJson(target, record);
  return { ok: true, record };
}

export function parseKillAttestationFile(path: string): {
  record: KillAttestationRecord | null;
  failures: string[];
} {
  const failures: string[] = [];
  if (!existsSync(path)) {
    return { record: null, failures: ["missing"] };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err: unknown) {
    return { record: null, failures: [`unreadable: ${String((err as Error).message ?? err)}`] };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch (err: unknown) {
    const msg = err instanceof SyntaxError ? err.message : String(err);
    return { record: null, failures: [`malformed JSON: ${msg}`] };
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { record: null, failures: ["top-level must be a JSON object"] };
  }
  const obj = payload as Record<string, unknown>;
  if (obj.schema !== KILL_ATTESTATION_SCHEMA) {
    failures.push(`schema must be ${KILL_ATTESTATION_SCHEMA}`);
  }
  for (const field of ["agent_id", "writer_id", "created_at", "expires_at"] as const) {
    if (typeof obj[field] !== "string" || (obj[field] as string).trim().length === 0) {
      failures.push(`${field} must be a non-empty string`);
    }
  }
  if (!isKillAttestationKind(obj.kind)) {
    failures.push(`kind must be one of ${KILL_ATTESTATION_KINDS.join("|")}`);
  }
  if (obj.reason !== undefined && typeof obj.reason !== "string") {
    failures.push("reason must be a string when present");
  }
  if (
    isKillAttestationKind(obj.kind) &&
    obj.kind === "force" &&
    (typeof obj.reason !== "string" || obj.reason.trim().length === 0)
  ) {
    failures.push("kind:force requires a non-empty reason");
  }
  if (failures.length > 0) {
    return { record: null, failures };
  }
  const created = parseIso8601Utc(obj.created_at as string);
  const expires = parseIso8601Utc(obj.expires_at as string);
  if (created === null) failures.push("created_at must be ISO-8601 UTC");
  if (expires === null) failures.push("expires_at must be ISO-8601 UTC");
  if (created !== null && expires !== null) {
    const lifetimeMs = expires.getTime() - created.getTime();
    const maxMs = DEFAULT_KILL_ATTESTATION_TTL_SECONDS * 1000;
    if (lifetimeMs <= 0) {
      failures.push("expires_at must be after created_at");
    } else if (lifetimeMs > maxMs) {
      failures.push(
        `attestation lifetime must be <= ${DEFAULT_KILL_ATTESTATION_TTL_SECONDS}s (#5281)`,
      );
    }
  }
  if (failures.length > 0) {
    return { record: null, failures };
  }
  const record: KillAttestationRecord = {
    schema: KILL_ATTESTATION_SCHEMA,
    agent_id: (obj.agent_id as string).trim(),
    writer_id: (obj.writer_id as string).trim(),
    kind: obj.kind as KillAttestationKind,
    created_at: obj.created_at as string,
    expires_at: obj.expires_at as string,
  };
  if (typeof obj.reason === "string" && obj.reason.trim().length > 0) {
    record.reason = obj.reason.trim();
  }
  return { record, failures: [] };
}

/**
 * Host-status oracle for kill (#5281 Bound item 4 / S2).
 * Heartbeat STALE / REDISPATCH_OK alone must not clear attestation.
 */
export function classifyKillHostStatus(value: unknown): KillHostStatus {
  if (typeof value !== "string") return "unknown";
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  if (
    normalized === "terminal" ||
    normalized === "completed" ||
    normalized === "complete" ||
    normalized === "failed" ||
    normalized === "cancelled" ||
    normalized === "canceled" ||
    normalized === "exited" ||
    normalized === "done" ||
    normalized === "succeeded" ||
    normalized === "success"
  ) {
    return "terminal";
  }
  if (
    normalized === "running" ||
    normalized === "in-flight" ||
    normalized === "inflight" ||
    normalized === "active" ||
    normalized === "pending" ||
    normalized === "starting"
  ) {
    return "running";
  }
  return "unknown";
}

export function evaluateKillAttestation(
  input: EvaluateKillAttestationInput,
): KillAttestationVerdict {
  const agentId = input.agentId.trim();
  const writerId = input.writerId.trim();
  const now = input.now ?? new Date();
  const base = {
    agent_id: agentId,
    writer_id: writerId,
    attestation: null as KillAttestationRecord | null,
    printed_force_reason: null as string | null,
  };

  if (agentId.length === 0) {
    return {
      ...base,
      ok: false,
      clear_reason: null,
      refuse_reason: "missing-target",
      message:
        "Directive denied kill_command_or_subagent: missing task_id/agent_id target for attestation gate (#5281).",
    };
  }

  const hostStatus = input.hostStatus ?? "unknown";
  if (hostStatus === "terminal") {
    return {
      ...base,
      ok: true,
      clear_reason: "host-terminal",
      refuse_reason: null,
      message:
        "Directive allowed kill_command_or_subagent: host task status is terminal (nothing left to protect).",
    };
  }

  if (input.evaluatePreCancelGreen !== undefined) {
    let green = false;
    try {
      green = input.evaluatePreCancelGreen() === true;
    } catch {
      green = false;
    }
    if (green) {
      return {
        ...base,
        ok: true,
        clear_reason: "pre-cancel-green",
        refuse_reason: null,
        message:
          "Directive allowed kill_command_or_subagent: green subagent:pre-cancel attestation (#5278 tip / #5281).",
      };
    }
  }

  const forceRequested = input.force === true;
  const forceReason = input.forceReason?.trim() ?? "";
  if (forceRequested) {
    if (forceReason.length === 0) {
      return {
        ...base,
        ok: false,
        clear_reason: null,
        refuse_reason: "force-missing-reason",
        message:
          "Directive denied kill_command_or_subagent: force requires a non-empty printed reason (#5281).",
      };
    }
    return {
      ...base,
      ok: true,
      clear_reason: "force",
      refuse_reason: null,
      printed_force_reason: forceReason,
      message: `Directive allowed kill_command_or_subagent via force: ${forceReason}`,
    };
  }

  const path = killAttestationPath(input.attestationDir, agentId);
  if (path === null) {
    return {
      ...base,
      ok: false,
      clear_reason: null,
      refuse_reason: "missing-target",
      message: "kill attestation agent_id is not a usable path slug (#5281).",
    };
  }
  const parsed = parseKillAttestationFile(path);
  if (parsed.record === null) {
    const refuse: KillAttestationRefuseReason =
      hostStatus === "unknown" ? "status-unknown-unattested" : "still-running-unattested";
    return {
      ...base,
      ok: false,
      clear_reason: null,
      refuse_reason: parsed.failures.includes("missing") ? "missing-attestation" : refuse,
      message:
        "Directive denied kill_command_or_subagent: still-running (or status-unknown) child " +
        "requires green pre-cancel / equivalent kill attestation under " +
        `.deft-scratch/subagent-kill-attestation/ before host kill (#5281). Soft English is not attestation.`,
    };
  }

  const record = parsed.record;
  base.attestation = record;
  if (record.agent_id !== agentId) {
    return {
      ...base,
      ok: false,
      clear_reason: null,
      refuse_reason: "invalid-attestation",
      message:
        "Directive denied kill_command_or_subagent: attestation agent_id does not match kill target (#5281).",
    };
  }

  const created = parseIso8601Utc(record.created_at);
  const expires = parseIso8601Utc(record.expires_at);
  const maxMs = DEFAULT_KILL_ATTESTATION_TTL_SECONDS * 1000;
  if (
    created === null ||
    expires === null ||
    expires.getTime() <= now.getTime() ||
    created.getTime() > now.getTime() + 1000 ||
    expires.getTime() - created.getTime() > maxMs ||
    now.getTime() - created.getTime() > maxMs
  ) {
    return {
      ...base,
      ok: false,
      clear_reason: null,
      refuse_reason: "expired-attestation",
      message:
        "Directive denied kill_command_or_subagent: kill attestation expired or lifetime exceeds " +
        `${DEFAULT_KILL_ATTESTATION_TTL_SECONDS}s TTL; re-attest before kill (#5281).`,
    };
  }

  // writer_id(=killer) required for note/correction/force artifacts (#5281 Prefer-A).
  if (record.writer_id !== writerId) {
    return {
      ...base,
      ok: false,
      clear_reason: null,
      refuse_reason: "writer-mismatch",
      message:
        "Directive denied kill_command_or_subagent: attestation writer_id must equal the killer (#5281).",
    };
  }

  if (record.kind === "force") {
    const reason = record.reason?.trim() ?? "";
    if (reason.length === 0) {
      return {
        ...base,
        ok: false,
        clear_reason: null,
        refuse_reason: "force-missing-reason",
        message:
          "Directive denied kill_command_or_subagent: attestation kind:force requires non-empty reason (#5281).",
      };
    }
    return {
      ...base,
      ok: true,
      clear_reason: "force",
      refuse_reason: null,
      printed_force_reason: reason,
      message: `Directive allowed kill_command_or_subagent via force attestation: ${reason}`,
    };
  }

  return {
    ...base,
    ok: true,
    clear_reason: "equivalent-attestation",
    refuse_reason: null,
    message:
      "Directive allowed kill_command_or_subagent: green equivalent kill attestation (#5281).",
  };
}
