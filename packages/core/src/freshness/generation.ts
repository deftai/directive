/**
 * Live deposit generation token (#3117).
 *
 * Stamped on successful deposit apply/refresh as a monotonic integer so long-lived
 * sessions can compare bound vs live without host-specific session APIs.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ContainedWriteError, containedWrite } from "../fs/contained-write.js";
import {
  FRESHNESS_SCHEMA_VERSION,
  type FreshnessSurface,
  type LiveGeneration,
  type SurfaceFingerprints,
} from "./types.js";

/**
 * Relative path under project for the live generation token.
 *
 * Lives under `.deft/` (not `.deft/core/`) so a full-tree payload replace
 * (`replaceTree` on update) does not wipe the monotonic counter (#3117).
 */
export const LIVE_GENERATION_REL = join(".deft", "GENERATION.json");

export function liveGenerationPath(projectRoot: string): string {
  return join(resolve(projectRoot), LIVE_GENERATION_REL);
}

export interface StampLiveGenerationOptions {
  readonly contentVersion: string;
  readonly stampedBy: string;
  /**
   * When true, always bump the monotonic counter (payload swapped / init apply).
   * When false, ensure the token exists and matches contentVersion without bumping
   * if already current (already-current refresh path).
   */
  readonly increment: boolean;
  readonly nowIso?: string;
  readonly surfaces?: SurfaceFingerprints;
}

function nowIsoDefault(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/, "");
}

/** Build default surface fingerprints from a content version string. */
export function defaultSurfaceFingerprints(contentVersion: string): SurfaceFingerprints {
  const v = normalizeVersion(contentVersion);
  const tagged = v.startsWith("v") ? v : `v${v}`;
  return {
    payload: v,
    version: tagged,
    templates: v,
    skills: v,
    docs: v,
  };
}

function isSurfaceFingerprints(value: unknown): value is SurfaceFingerprints {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof k !== "string" || typeof v !== "string") {
      return false;
    }
  }
  return true;
}

/** Parse a live generation record from disk JSON (or null if invalid/missing). */
export function parseLiveGeneration(raw: unknown): LiveGeneration | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  const generation = rec.generation;
  if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 1) {
    return null;
  }
  const contentVersion =
    typeof rec.contentVersion === "string" && rec.contentVersion.trim()
      ? rec.contentVersion.trim()
      : null;
  if (contentVersion === null) {
    return null;
  }
  const stampedAt =
    typeof rec.stampedAt === "string" && rec.stampedAt.trim() ? rec.stampedAt.trim() : null;
  if (stampedAt === null) {
    return null;
  }
  const stampedBy =
    typeof rec.stampedBy === "string" && rec.stampedBy.trim() ? rec.stampedBy.trim() : "unknown";
  const surfaces = isSurfaceFingerprints(rec.surfaces)
    ? rec.surfaces
    : defaultSurfaceFingerprints(contentVersion);
  return {
    schemaVersion: FRESHNESS_SCHEMA_VERSION,
    generation,
    contentVersion: normalizeVersion(contentVersion),
    stampedAt,
    stampedBy,
    surfaces,
  };
}

/** Read the live generation token from the deposit (null when absent/unreadable). */
export function readLiveGeneration(projectRoot: string): LiveGeneration | null {
  const path = liveGenerationPath(projectRoot);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const text = readFileSync(path, "utf8");
    const parsed: unknown = JSON.parse(text);
    return parseLiveGeneration(parsed);
  } catch {
    return null;
  }
}

function writeLiveGeneration(projectRoot: string, token: LiveGeneration): string {
  const root = resolve(projectRoot);
  const target = liveGenerationPath(projectRoot);
  const body = `${JSON.stringify(token, null, 2)}\n`;
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
 * Stamp (or ensure) the live deposit generation token after a successful apply.
 *
 * Monotonic: successful payload swap / init always increments. Already-current
 * refresh ensures a readable token exists without advancing the counter when the
 * content version is unchanged.
 */
export function stampLiveGeneration(
  projectRoot: string,
  options: StampLiveGenerationOptions,
): LiveGeneration {
  const contentVersion = normalizeVersion(options.contentVersion);
  const surfaces = options.surfaces ?? defaultSurfaceFingerprints(contentVersion);
  const stampedAt = options.nowIso ?? nowIsoDefault();
  const prior = readLiveGeneration(projectRoot);

  let generation: number;
  if (prior === null) {
    generation = 1;
  } else if (options.increment) {
    generation = prior.generation + 1;
  } else if (normalizeVersion(prior.contentVersion) !== contentVersion) {
    // Content drifted without an explicit increment flag — still advance.
    generation = prior.generation + 1;
  } else {
    // Already current: do not rewrite GENERATION.json (avoids dirty trees under
    // core.autocrlf=true after idempotent `directive update` — Windows #2118).
    return prior;
  }

  const token: LiveGeneration = {
    schemaVersion: FRESHNESS_SCHEMA_VERSION,
    generation,
    contentVersion,
    stampedAt,
    stampedBy: options.stampedBy,
    surfaces,
  };
  writeLiveGeneration(projectRoot, token);
  return token;
}

/** Surfaces that differ between two fingerprint maps. */
export function differingSurfaces(
  bound: SurfaceFingerprints | null | undefined,
  live: SurfaceFingerprints | null | undefined,
  surfaceSet: readonly FreshnessSurface[] = ["payload", "version", "templates", "skills", "docs"],
): FreshnessSurface[] {
  const out: FreshnessSurface[] = [];
  for (const surface of surfaceSet) {
    const b = bound?.[surface] ?? null;
    const l = live?.[surface] ?? null;
    if (b === null && l === null) {
      continue;
    }
    if (b !== l) {
      out.push(surface);
    }
  }
  return out;
}
