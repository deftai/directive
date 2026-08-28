/**
 * Session bind of live deposit generation (#3117).
 *
 * Host-agnostic storage:
 * - Default (no sessionId): `.deft/session-bind.json` — single-operator convenience.
 * - With sessionId: `.deft/session-binds/<sha256-slice>.json` — isolated multi-session binds.
 *
 * Multi-agent hosts MUST pass a stable host session identity when binding and
 * reporting so one session cannot certify another as current.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ContainedWriteError, containedWrite } from "../fs/contained-write.js";
import { readLiveGeneration, stampLiveGeneration } from "./generation.js";
import {
  type BoundGeneration,
  FRESHNESS_SCHEMA_VERSION,
  type LiveGeneration,
  type SurfaceFingerprints,
} from "./types.js";

/** Relative path for the default (no-sessionId) bind record. */
export const SESSION_BIND_REL = join(".deft", "session-bind.json");

/** Directory for per-session bind records. */
export const SESSION_BINDS_DIR_REL = join(".deft", "session-binds");

export function sessionBindPath(projectRoot: string, sessionId?: string | null): string {
  const root = resolve(projectRoot);
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (id.length === 0) {
    return join(root, SESSION_BIND_REL);
  }
  return join(root, SESSION_BINDS_DIR_REL, safeSessionFileName(id));
}

function sessionIdHash(sessionId: string): string {
  return createHash("sha256").update(sessionId.trim(), "utf8").digest("hex").slice(0, 24);
}

/**
 * Stable filesystem-safe file name for a host session id.
 *
 * Hash only (#3768): a 24-hex SHA-256 slice of the id. Hex cannot carry a path
 * separator, so path injection is structurally impossible, and the name stays
 * derivable from the id — lookup is one computed path, never a directory scan.
 *
 * Records written before #3768 also carried the first 32 characters of the id
 * (`legacySessionFileName`). Dropping that prefix is hygiene, not a security
 * fix: the same id is already published in `.deft/occupancy.json`,
 * `.deft/ritual-state.json` and the bind record body (#3611 / #3754).
 *
 * Coupling warning: if `.deft/` JSON bodies are ever tightened (say to `0600`)
 * while names still carry the prefix, the prefix becomes independently
 * load-bearing — directory read permission alone would recover an id that the
 * file mode was meant to protect. Anyone tightening those modes must keep bind
 * names prefix-free.
 */
export function safeSessionFileName(sessionId: string): string {
  return `${sessionIdHash(sessionId)}.json`;
}

/**
 * Pre-#3768 record name: sanitized 32-character id prefix plus the same hash.
 *
 * Existing records are **tolerated, not migrated**. `readBoundGeneration` falls
 * back to this name when the hash-only record is absent, so freshness pins
 * written before the rename are not orphaned; writes always use the hash-only
 * name, so the next bind supersedes the legacy record. Both names derive from
 * the id, so the fallback stays O(1) and adds no directory scan.
 *
 * Character filter is O(n) (no regex) — CodeQL poly-redos on uncontrolled ids.
 */
export function legacySessionFileName(sessionId: string): string {
  const trimmed = sessionId.trim();
  const hash = sessionIdHash(trimmed);
  let prefix = "";
  for (let i = 0; i < trimmed.length && prefix.length < 32; i++) {
    const ch = trimmed[i] ?? "";
    const code = ch.charCodeAt(0);
    const ok =
      (code >= 48 && code <= 57) || // 0-9
      (code >= 65 && code <= 90) || // A-Z
      (code >= 97 && code <= 122) || // a-z
      ch === "." ||
      ch === "_" ||
      ch === "-";
    if (ok) {
      prefix += ch;
    } else if (prefix.length === 0 || prefix[prefix.length - 1] !== "_") {
      prefix += "_";
    }
  }
  while (prefix.startsWith("_")) {
    prefix = prefix.slice(1);
  }
  while (prefix.endsWith("_")) {
    prefix = prefix.slice(0, -1);
  }
  const base = prefix.length > 0 ? `${prefix}-${hash}` : hash;
  return `${base}.json`;
}

/**
 * Derived path of a pre-#3768 record. Read fallback only — never a write target.
 */
export function legacySessionBindPath(projectRoot: string, sessionId: string): string {
  return join(resolve(projectRoot), SESSION_BINDS_DIR_REL, legacySessionFileName(sessionId));
}

export interface BindSessionOptions {
  readonly sessionId?: string | null;
  readonly nowIso?: string;
  /**
   * When live generation is missing (legacy deposit), stamp generation 1 from
   * contentVersion before binding. Default true.
   */
  readonly ensureLive?: boolean;
  /** Used only when ensuring a missing live token. */
  readonly contentVersion?: string;
  readonly stampedBy?: string;
  /**
   * When binding with a sessionId, also write the default bind path.
   * Default **false** — multi-agent isolation requires hosts to report with
   * `--session-id`. Enabling this reopens cross-session false-current (Greptile).
   */
  readonly alsoWriteDefault?: boolean;
  /**
   * Host attests that payload surfaces for the live generation were reloaded
   * into the session. Required for trusted readiness. Default false.
   */
  readonly payloadLoaded?: boolean;
}

export interface ReadBoundOptions {
  /** When set, read only that session's bind (never the default). */
  readonly sessionId?: string | null;
}

function nowIsoDefault(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Parse a bound generation record (null if invalid). */
export function parseBoundGeneration(raw: unknown): BoundGeneration | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  const boundGeneration = rec.boundGeneration;
  if (
    typeof boundGeneration !== "number" ||
    !Number.isInteger(boundGeneration) ||
    boundGeneration < 1
  ) {
    return null;
  }
  const boundAt = typeof rec.boundAt === "string" && rec.boundAt.trim() ? rec.boundAt.trim() : null;
  if (boundAt === null) {
    return null;
  }
  const contentVersion =
    typeof rec.contentVersion === "string" && rec.contentVersion.trim()
      ? rec.contentVersion.trim()
      : "";
  let surfaces: SurfaceFingerprints = {};
  if (typeof rec.surfaces === "object" && rec.surfaces !== null && !Array.isArray(rec.surfaces)) {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(rec.surfaces as Record<string, unknown>)) {
      if (typeof v === "string") {
        next[k] = v;
      }
    }
    surfaces = next;
  }
  const sessionId =
    typeof rec.sessionId === "string" && rec.sessionId.trim()
      ? rec.sessionId.trim()
      : rec.sessionId === null
        ? null
        : undefined;
  const payloadLoaded = rec.payloadLoaded === true;
  return {
    schemaVersion: FRESHNESS_SCHEMA_VERSION,
    boundGeneration,
    boundAt,
    contentVersion,
    surfaces,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(payloadLoaded ? { payloadLoaded: true } : {}),
  };
}

function readBoundAt(path: string, wantSessionId: string): BoundGeneration | null {
  try {
    const text = readFileSync(path, "utf8");
    const bound = parseBoundGeneration(JSON.parse(text) as unknown);
    if (bound === null) {
      return null;
    }
    // When reading a session-scoped bind, refuse a record whose embedded
    // sessionId disagrees (tamper / wrong file).
    if (wantSessionId.length > 0 && bound.sessionId && bound.sessionId !== wantSessionId) {
      return null;
    }
    return bound;
  } catch {
    return null;
  }
}

/** Read the session bind record (null when absent/unreadable). */
export function readBoundGeneration(
  projectRoot: string,
  options: ReadBoundOptions = {},
): BoundGeneration | null {
  const want = typeof options.sessionId === "string" ? options.sessionId.trim() : "";
  const path = sessionBindPath(projectRoot, options.sessionId);
  if (existsSync(path)) {
    return readBoundAt(path, want);
  }
  if (want.length === 0) {
    return null;
  }
  // Pre-#3768 records are tolerated, not migrated: one extra derived path and
  // still no directory scan, so pins written under the old name resolve until
  // the next bind supersedes them.
  const legacy = legacySessionBindPath(projectRoot, want);
  return existsSync(legacy) ? readBoundAt(legacy, want) : null;
}

function writeBoundAt(
  projectRoot: string,
  bound: BoundGeneration,
  sessionId?: string | null,
): string {
  const root = resolve(projectRoot);
  const target = sessionBindPath(projectRoot, sessionId);
  const body = `${JSON.stringify(bound, null, 2)}\n`;
  try {
    containedWrite({
      root,
      target,
      data: body,
      mode: "replace",
    });
  } catch (err) {
    if (err instanceof ContainedWriteError) {
      throw err;
    }
    throw err;
  }
  return target;
}

/**
 * Bind the current live generation into session context.
 *
 * Does not require restarting a shared host runtime — callers re-load payload
 * surfaces into the session and call this (or `freshness:bind`) to rebind.
 *
 * Multi-agent hosts MUST supply `sessionId` so binds do not overwrite each other.
 */
export function bindSessionGeneration(
  projectRoot: string,
  options: BindSessionOptions = {},
): { bound: BoundGeneration; live: LiveGeneration; path: string } {
  let live = readLiveGeneration(projectRoot);
  if (live === null && options.ensureLive !== false) {
    const contentVersion = options.contentVersion?.trim() || "0.0.0";
    live = stampLiveGeneration(projectRoot, {
      contentVersion,
      stampedBy: options.stampedBy ?? "session-bind",
      increment: false,
      nowIso: options.nowIso,
    });
  }
  if (live === null) {
    throw new Error(
      "freshness bind: no live generation token on disk; run directive update or init first",
    );
  }

  const sessionId =
    typeof options.sessionId === "string" && options.sessionId.trim()
      ? options.sessionId.trim()
      : options.sessionId === null
        ? null
        : undefined;

  const bound: BoundGeneration = {
    schemaVersion: FRESHNESS_SCHEMA_VERSION,
    boundGeneration: live.generation,
    boundAt: options.nowIso ?? nowIsoDefault(),
    contentVersion: live.contentVersion,
    surfaces: { ...live.surfaces },
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(options.payloadLoaded === true ? { payloadLoaded: true } : {}),
  };

  const path = writeBoundAt(projectRoot, bound, sessionId ?? null);

  // Opt-in only: never mirror session-scoped binds into the default path by
  // default (that would let bare freshness:report certify another session).
  if (
    sessionId &&
    options.alsoWriteDefault === true &&
    path !== sessionBindPath(projectRoot, null)
  ) {
    writeBoundAt(projectRoot, bound, null);
  }

  return { bound, live, path };
}
