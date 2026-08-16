/**
 * Approved-scope digest helpers (#3145).
 *
 * At activation/approval time, record an immutable digest of the human-approved
 * file_scope. PR verification compares the live active xBRIEF against this
 * baseline so same-PR xBRIEF edits cannot self-authorize new paths.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";

/** Immutable approved-scope record written under `.deft/approved-scope/`. */
export interface ApprovedScopeRecord {
  readonly schemaVersion: 1;
  /** Repo-relative path of the active xBRIEF at approval time. */
  readonly xbriefRelPath: string;
  readonly planId: string;
  /** ISO-8601 UTC timestamp of approval / activation. */
  readonly approvedAt: string;
  /** Sorted unique file_scope paths frozen at approval. */
  readonly fileScope: readonly string[];
  /** sha256 hex of normalized file_scope lines. */
  readonly fileScopeDigest: string;
  /**
   * Optional human-origin stamp (refs #2944). When present on renewal,
   * re-approval is accepted. Agent-only stamps are ignored by evaluate.
   */
  readonly humanApproval?: {
    readonly kind: string;
    readonly actor: string;
    readonly mintedAt: string;
    readonly mintedVia?: string;
  };
  /**
   * Legacy optional body digest. Wave 1 (#3384 F4) does not write this on new
   * records. Do not treat it as authority (Wave 2 #3385 / R6).
   */
  readonly xbriefBodyDigest?: string;
}

export const APPROVED_SCOPE_DIR = ".deft/approved-scope";

/** Normalize and sort scope paths for stable digests. */
export function normalizeFileScope(paths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    if (typeof p !== "string") continue;
    const n = p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (n.length > 0) out.add(n);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/** sha256 hex of normalized file_scope (one path per line). */
export function computeFileScopeDigest(paths: readonly string[]): string {
  const normalized = normalizeFileScope(paths);
  const payload = `${normalized.join("\n")}\n`;
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/** sha256 hex of raw UTF-8 text. */
export function computeTextDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Extract plan.metadata.swarm.file_scope from an xBRIEF payload. */
export function extractFileScope(payload: unknown): string[] {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }
  const plan = (payload as Record<string, unknown>).plan;
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    return [];
  }
  const metadata = (plan as Record<string, unknown>).metadata;
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return [];
  }
  const swarm = (metadata as Record<string, unknown>).swarm;
  if (swarm === null || typeof swarm !== "object" || Array.isArray(swarm)) {
    return [];
  }
  const fileScope = (swarm as Record<string, unknown>).file_scope;
  if (!Array.isArray(fileScope)) return [];
  return fileScope.filter((x): x is string => typeof x === "string");
}

/** Extract plan.id from an xBRIEF payload. */
export function extractPlanId(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const plan = (payload as Record<string, unknown>).plan;
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    return null;
  }
  const id = (plan as Record<string, unknown>).id;
  return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
}

export function approvedScopeDir(projectRoot: string): string {
  return join(resolve(projectRoot), ...APPROVED_SCOPE_DIR.split("/"));
}

export function approvedScopeRecordPath(projectRoot: string, planId: string): string {
  const safe = planId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(approvedScopeDir(projectRoot), `${safe}.json`);
}

/** Build an ApprovedScopeRecord from xBRIEF payload + metadata. */
export function buildApprovedScopeRecord(input: {
  readonly xbriefRelPath: string;
  readonly payload: unknown;
  readonly approvedAt?: string;
  readonly humanApproval?: ApprovedScopeRecord["humanApproval"];
  /**
   * Ignored. Wave 1 (#3384 F4) no longer writes `xbriefBodyDigest` on new records.
   * Kept so existing callers do not have to drop the field in the same change.
   */
  readonly xbriefRawText?: string;
}): ApprovedScopeRecord {
  const planId = extractPlanId(input.payload) ?? basename(input.xbriefRelPath, ".xbrief.json");
  const fileScope = normalizeFileScope(extractFileScope(input.payload));
  const fileScopeDigest = computeFileScopeDigest(fileScope);
  const approvedAt = input.approvedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const record: ApprovedScopeRecord = {
    schemaVersion: 1,
    xbriefRelPath: input.xbriefRelPath.replace(/\\/g, "/"),
    planId,
    approvedAt,
    fileScope,
    fileScopeDigest,
  };
  if (input.humanApproval !== undefined) {
    return { ...record, humanApproval: input.humanApproval };
  }
  return record;
}

/** Persist approved-scope record (activation / renewed human approval). */
export function writeApprovedScopeRecord(projectRoot: string, record: ApprovedScopeRecord): string {
  const dir = approvedScopeDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  const path = approvedScopeRecordPath(projectRoot, record.planId);
  containedWrite({
    root: resolve(projectRoot),
    target: path,
    data: `${JSON.stringify(record, null, 2)}\n`,
    mode: "replace",
  });
  return path;
}

/** Load one approved-scope record by plan id, or null if missing. */
export function readApprovedScopeRecord(
  projectRoot: string,
  planId: string,
): ApprovedScopeRecord | null {
  const path = approvedScopeRecordPath(projectRoot, planId);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const rec = raw as Record<string, unknown>;
    if (typeof rec.fileScopeDigest !== "string" || !Array.isArray(rec.fileScope)) return null;
    return raw as ApprovedScopeRecord;
  } catch {
    return null;
  }
}

/** Load all approved-scope records under `.deft/approved-scope/`. */
export function listApprovedScopeRecords(projectRoot: string): ApprovedScopeRecord[] {
  const dir = approvedScopeDir(projectRoot);
  if (!existsSync(dir)) return [];
  const out: ApprovedScopeRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown;
      if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
        const rec = raw as ApprovedScopeRecord;
        if (typeof rec.fileScopeDigest === "string") out.push(rec);
      }
    } catch {
      // skip malformed
    }
  }
  return out;
}

/**
 * Paths present in `current` but not in `approved` (normalized).
 * These are the expansion set that cannot self-authorize.
 */
export function scopeExpansion(approved: readonly string[], current: readonly string[]): string[] {
  const base = new Set(normalizeFileScope(approved));
  return normalizeFileScope(current).filter((p) => !base.has(p));
}

/** True when actor/kind look like human provenance (mirrors authz subset). */
export function isHumanApprovalStamp(
  stamp: ApprovedScopeRecord["humanApproval"] | null | undefined,
): boolean {
  if (stamp === null || stamp === undefined) return false;
  const kind = (stamp.kind ?? "").trim().toLowerCase();
  const actor = (stamp.actor ?? "").trim().toLowerCase();
  if (kind.length === 0 || actor.length === 0) return false;
  if (actor === "agent" || actor.startsWith("agent:") || actor === "self") return false;
  if (kind === "agent" || kind === "self" || kind === "xbrief" || kind === "dispatch") return false;
  // Accept common human kinds from #2944 surface
  const humanKinds = new Set([
    "cli",
    "operator",
    "human",
    "user",
    "github-user",
    "interactive",
    "renewed-approval",
  ]);
  return humanKinds.has(kind) || kind.startsWith("human");
}
