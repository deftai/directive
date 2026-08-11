/**
 * Persisted orientation deposit fingerprint (#3286).
 *
 * Enables agents:refresh / verify:cache-fresh one-line sha-match no-ops on
 * repeat sessions when payload + templates + engine are unchanged.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";

export const ORIENTATION_STATE_REL = join(".deft", "orientation-state.json");
export const ORIENTATION_STATE_SCHEMA = 1 as const;

export interface OrientationSurfaceRecord {
  readonly ok: boolean;
  readonly ts: string;
  readonly exit_code: number;
  readonly message?: string;
}

export interface OrientationState {
  readonly schema_version: typeof ORIENTATION_STATE_SCHEMA;
  readonly deposit_sha: string;
  readonly updated_at: string;
  readonly agents_refresh?: OrientationSurfaceRecord;
  readonly cache_fresh?: OrientationSurfaceRecord;
  readonly doctor?: OrientationSurfaceRecord;
  readonly preflight?: OrientationSurfaceRecord;
}

export function orientationStatePath(projectRoot: string): string {
  return join(resolve(projectRoot), ORIENTATION_STATE_REL);
}

function parseRecord(raw: unknown): OrientationSurfaceRecord | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.ok !== "boolean") return undefined;
  if (typeof rec.ts !== "string" || rec.ts.trim().length === 0) return undefined;
  const exit = typeof rec.exit_code === "number" ? rec.exit_code : rec.ok ? 0 : 1;
  return {
    ok: rec.ok,
    ts: rec.ts,
    exit_code: exit,
    message: typeof rec.message === "string" ? rec.message : undefined,
  };
}

export function parseOrientationState(raw: unknown): OrientationState | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.deposit_sha !== "string" || rec.deposit_sha.trim().length === 0) return null;
  if (typeof rec.updated_at !== "string" || rec.updated_at.trim().length === 0) return null;
  const schema =
    typeof rec.schema_version === "number" ? rec.schema_version : ORIENTATION_STATE_SCHEMA;
  if (schema !== ORIENTATION_STATE_SCHEMA) return null;
  return {
    schema_version: ORIENTATION_STATE_SCHEMA,
    deposit_sha: rec.deposit_sha.trim(),
    updated_at: rec.updated_at.trim(),
    agents_refresh: parseRecord(rec.agents_refresh),
    cache_fresh: parseRecord(rec.cache_fresh),
    doctor: parseRecord(rec.doctor),
    preflight: parseRecord(rec.preflight),
  };
}

export function readOrientationState(projectRoot: string): OrientationState | null {
  const path = orientationStatePath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, "utf8");
    return parseOrientationState(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

export function writeOrientationState(projectRoot: string, state: OrientationState): string {
  const path = orientationStatePath(projectRoot);
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  const body = `${JSON.stringify(state, null, 2)}\n`;
  containedWrite({
    root: resolve(projectRoot),
    target: path,
    data: body,
    mode: "replace",
  });
  return path;
}

export function surfaceRecord(
  ok: boolean,
  exitCode: number,
  now: Date,
  message?: string,
): OrientationSurfaceRecord {
  return {
    ok,
    ts: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    exit_code: exitCode,
    ...(message !== undefined ? { message } : {}),
  };
}
