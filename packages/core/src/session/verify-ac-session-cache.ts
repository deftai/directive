/**
 * Same-session verify:ac result cache (#3387).
 *
 * Disk-backed so check composition (spawned verify:ac) can serve from_cache
 * after a green run in the same session when plan + product hash still match.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { sanitizeScopeIdForFilename } from "./ac-pass-banking.js";

export const VERIFY_AC_SESSION_CACHE_DIR = ".deft/cache/verify-ac-session-cache";

export const AC_SERVED_FROM = ["bank", "cache", "executed", "refused"] as const;

export type AcServedFrom = (typeof AC_SERVED_FROM)[number];

export interface CachedVerifyAcSnapshot {
  readonly ok: boolean;
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly commands: readonly unknown[];
  readonly runs: readonly unknown[];
  readonly rejected?: readonly unknown[];
  readonly sourceRung: string;
  readonly noneStated: boolean;
  readonly acceptance: unknown;
  readonly resolution: string;
  readonly resolvedCommandCount: number;
}

export interface VerifyAcSessionCacheRecord {
  readonly sessionId: string;
  readonly scopeId: string;
  readonly productStateHash: string;
  readonly cachedAt: string;
  readonly snapshot: CachedVerifyAcSnapshot;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function verifyAcSessionCacheDir(projectRoot: string): string {
  return join(resolve(projectRoot), ...VERIFY_AC_SESSION_CACHE_DIR.split("/"));
}

export function verifyAcSessionCachePath(
  projectRoot: string,
  sessionId: string,
  scopeId: string,
): string {
  const safeSession = sanitizeScopeIdForFilename(sessionId);
  const safeScope = sanitizeScopeIdForFilename(scopeId);
  return join(verifyAcSessionCacheDir(projectRoot), `${safeSession}-${safeScope}.json`);
}

export function resolveVerifyAcSessionId(
  env?: Readonly<Record<string, string | undefined>>,
  explicit?: string | null,
): string | null {
  const injected = explicit?.trim() ?? "";
  if (injected.length > 0) return injected;
  const fromEnv = typeof env?.DEFT_SESSION_ID === "string" ? env.DEFT_SESSION_ID.trim() : "";
  return fromEnv.length > 0 ? fromEnv : null;
}

function parseSnapshot(raw: unknown): CachedVerifyAcSnapshot | null {
  const rec = asRecord(raw);
  if (rec === null) return null;
  if (typeof rec.ok !== "boolean") return null;
  if (rec.code !== 0 && rec.code !== 1 && rec.code !== 2) return null;
  if (typeof rec.message !== "string") return null;
  if (!Array.isArray(rec.commands) || !Array.isArray(rec.runs)) return null;
  if (typeof rec.sourceRung !== "string") return null;
  if (typeof rec.noneStated !== "boolean") return null;
  if (typeof rec.resolution !== "string") return null;
  if (typeof rec.resolvedCommandCount !== "number") return null;
  return {
    ok: rec.ok,
    code: rec.code,
    message: rec.message,
    commands: rec.commands,
    runs: rec.runs,
    rejected: Array.isArray(rec.rejected) ? rec.rejected : undefined,
    sourceRung: rec.sourceRung,
    noneStated: rec.noneStated,
    acceptance: rec.acceptance,
    resolution: rec.resolution,
    resolvedCommandCount: rec.resolvedCommandCount,
  };
}

export function readVerifyAcSessionCache(
  projectRoot: string,
  sessionId: string,
  scopeId: string,
): VerifyAcSessionCacheRecord | null {
  const path = verifyAcSessionCachePath(projectRoot, sessionId, scopeId);
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, { encoding: "utf8" });
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const rec = asRecord(parsed);
    if (rec === null) return null;
    if (rec.sessionId !== sessionId || rec.scopeId !== scopeId) return null;
    if (typeof rec.productStateHash !== "string" || rec.productStateHash.length === 0) {
      return null;
    }
    const snapshot = parseSnapshot(rec.snapshot);
    if (snapshot === null || snapshot.ok !== true) return null;
    return {
      sessionId,
      scopeId,
      productStateHash: rec.productStateHash,
      cachedAt: typeof rec.cachedAt === "string" ? rec.cachedAt : "",
      snapshot,
    };
  } catch {
    return null;
  }
}

export function writeVerifyAcSessionCache(input: {
  readonly projectRoot: string;
  readonly sessionId: string;
  readonly scopeId: string;
  readonly productStateHash: string;
  readonly snapshot: CachedVerifyAcSnapshot;
  readonly now?: string;
}): VerifyAcSessionCacheRecord {
  const root = resolve(input.projectRoot);
  const path = verifyAcSessionCachePath(root, input.sessionId, input.scopeId);
  const dir = verifyAcSessionCacheDir(root);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const record: VerifyAcSessionCacheRecord = {
    sessionId: input.sessionId,
    scopeId: input.scopeId,
    productStateHash: input.productStateHash,
    cachedAt: input.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    snapshot: input.snapshot,
  };
  containedWrite({
    root,
    target: path,
    data: `${JSON.stringify(record, null, 2)}\n`,
    mode: "replace",
    mkdir: true,
  });
  return record;
}
