/**
 * Session bind of live deposit generation (#3117).
 *
 * Host-agnostic: stores bound generation under `.deft/session-bind.json` so any
 * long-lived multi-agent host can rebind without restarting the shared runtime.
 */

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

/** Relative path for the session bind record (project-local, host-agnostic). */
export const SESSION_BIND_REL = join(".deft", "session-bind.json");

export function sessionBindPath(projectRoot: string): string {
  return join(resolve(projectRoot), SESSION_BIND_REL);
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
  return {
    schemaVersion: FRESHNESS_SCHEMA_VERSION,
    boundGeneration,
    boundAt,
    contentVersion,
    surfaces,
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}

/** Read the session bind record (null when absent/unreadable). */
export function readBoundGeneration(projectRoot: string): BoundGeneration | null {
  const path = sessionBindPath(projectRoot);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const text = readFileSync(path, "utf8");
    return parseBoundGeneration(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

function writeBoundGeneration(projectRoot: string, bound: BoundGeneration): string {
  const root = resolve(projectRoot);
  const target = sessionBindPath(projectRoot);
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

  const bound: BoundGeneration = {
    schemaVersion: FRESHNESS_SCHEMA_VERSION,
    boundGeneration: live.generation,
    boundAt: options.nowIso ?? nowIsoDefault(),
    contentVersion: live.contentVersion,
    surfaces: { ...live.surfaces },
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
  };
  const path = writeBoundGeneration(projectRoot, bound);
  return { bound, live, path };
}
