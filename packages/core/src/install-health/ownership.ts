/**
 * GENERATION.json ownership/removal record (AC11.10 / AC13.2).
 *
 * Committed under `.deft/GENERATION.json`. Records the runtime version that last
 * ran setup, the package manager used (drift diagnostics only — not PM selection
 * SoT), and persistent ownership claims with fingerprints. Distinguishes wholly
 * owned files, Directive-owned marked sections / structured entries in shared
 * files, and settings/data retained on uninstall.
 *
 * AC13.2: the stable ownership record contains nothing that changes when version
 * and managed files are unchanged — no absolute paths, no per-run timestamps.
 * Legacy freshness fields (`stampedAt`, `stampedBy`, `generation`, `surfaces`,
 * `contentVersion`) are tolerated on read and stripped from stable fingerprints.
 * Representation is an implementation detail; no generic installer framework.
 *
 * Read/write helpers are pure over a project root and remain usable when the
 * runtime package is missing or damaged (record lives in committed `.deft/`).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ContainedWriteError, containedWrite } from "../fs/contained-write.js";

/** Relative path under project for the ownership-aware generation record. */
export const GENERATION_REL = ".deft/GENERATION.json";

/** Ownership schema version for the AC11.10 / AC13.2 record. */
export const OWNERSHIP_SCHEMA_VERSION = 1 as const;

/**
 * Existing Directive managed-section marker id (AC11.10: reuse, do not invent
 * an alternate convention). Open form: `<!-- deft:managed-section vN … -->`.
 */
export const MANAGED_SECTION_MARKER_ID = "deft:managed-section";

/** Open-marker prefix used by AGENTS.md / shared markdown managed sections. */
export const MANAGED_SECTION_OPEN_PREFIX = "<!-- deft:managed-section";

/** Close marker for managed sections (matches `AGENTS_MANAGED_CLOSE`). */
export const MANAGED_SECTION_CLOSE = "<!-- /deft:managed-section -->";

/** Package managers the ownership record may record as a setup fact. */
export const PACKAGE_MANAGER_FACTS = ["npm", "pnpm"] as const;
export type PackageManagerFact = (typeof PACKAGE_MANAGER_FACTS)[number];

/**
 * Ownership kind for a recorded artifact:
 * - `whole-file` — wholly Directive-owned; removable as a whole file
 * - `marked-section` — Directive-owned marked section inside a shared file
 * - `structured-entry` — Directive-owned structured entry (e.g. JSON key path)
 * - `retained` — settings/data that must survive uninstall
 */
export const OWNERSHIP_KINDS = [
  "whole-file",
  "marked-section",
  "structured-entry",
  "retained",
] as const;
export type OwnershipKind = (typeof OWNERSHIP_KINDS)[number];

/** One ownership/removal claim with a content fingerprint. */
export interface OwnedArtifact {
  /** Path relative to project root (POSIX separators; never absolute). */
  readonly path: string;
  readonly kind: OwnershipKind;
  /** Stable fingerprint of the owned material (sha256 hex of content). */
  readonly fingerprint: string;
  /** For `marked-section`: marker id (e.g. {@link MANAGED_SECTION_MARKER_ID}). */
  readonly markerId?: string;
  /** For `structured-entry`: key path / JSON pointer within the shared file. */
  readonly entryKey?: string;
}

/**
 * Stable ownership/removal record written into `.deft/GENERATION.json`.
 * Contains only fields that are unchanged when version + managed files are
 * unchanged (AC13.2).
 */
export interface SetupOwnershipRecord {
  readonly schemaVersion: typeof OWNERSHIP_SCHEMA_VERSION;
  /** Runtime version that last ran setup. */
  readonly runtimeVersion: string;
  /** PM used at last setup — diagnostic fact only, not PM selection SoT. */
  readonly packageManager: PackageManagerFact;
  readonly ownership: readonly OwnedArtifact[];
}

export type OwnershipInspection =
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly reason: "invalid-json" | "invalid-record" }
  | { readonly kind: "valid"; readonly record: SetupOwnershipRecord; readonly raw: string };

const OWNERSHIP_KIND_SET = new Set<string>(OWNERSHIP_KINDS);
const PACKAGE_MANAGER_SET = new Set<string>(PACKAGE_MANAGER_FACTS);

export function generationPath(projectRoot: string): string {
  return join(resolve(projectRoot), ".deft", "GENERATION.json");
}

/** Stable sha256 hex fingerprint of owned content. */
export function fingerprintContent(content: string | Uint8Array): string {
  const hash = createHash("sha256");
  if (typeof content === "string") {
    hash.update(content, "utf8");
  } else {
    hash.update(content);
  }
  return hash.digest("hex");
}

/**
 * Normalize a project-relative path to POSIX form. Rejects absolute paths
 * (AC13.2: no absolute paths in the ownership record).
 */
export function normalizeRelativePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    throw new Error("ownership path must be a non-empty relative path");
  }
  if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    throw new Error(`ownership path must not be absolute: ${trimmed}`);
  }
  // Strip leading ./ and collapse backslashes to POSIX separators.
  const posix = trimmed.replace(/\\/g, "/").replace(/^\.\//, "");
  if (posix.startsWith("/") || posix.includes("://")) {
    throw new Error(`ownership path must not be absolute: ${trimmed}`);
  }
  // Refuse path escape via ..
  const parts = posix.split("/");
  if (parts.some((p) => p === "..")) {
    throw new Error(`ownership path must not escape project root: ${trimmed}`);
  }
  return parts.filter((p) => p !== "." && p !== "").join("/");
}

function isPackageManagerFact(value: unknown): value is PackageManagerFact {
  return typeof value === "string" && PACKAGE_MANAGER_SET.has(value);
}

function isOwnershipKind(value: unknown): value is OwnershipKind {
  return typeof value === "string" && OWNERSHIP_KIND_SET.has(value);
}

function parseOwnedArtifact(raw: unknown): OwnedArtifact | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec.path !== "string" || !rec.path.trim()) {
    return null;
  }
  let path: string;
  try {
    path = normalizeRelativePath(rec.path);
  } catch {
    return null;
  }
  if (!isOwnershipKind(rec.kind)) {
    return null;
  }
  if (typeof rec.fingerprint !== "string" || !rec.fingerprint.trim()) {
    return null;
  }
  const artifact: {
    path: string;
    kind: OwnershipKind;
    fingerprint: string;
    markerId?: string;
    entryKey?: string;
  } = {
    path,
    kind: rec.kind,
    fingerprint: rec.fingerprint.trim(),
  };
  if (typeof rec.markerId === "string" && rec.markerId.trim()) {
    artifact.markerId = rec.markerId.trim();
  }
  if (typeof rec.entryKey === "string" && rec.entryKey.trim()) {
    artifact.entryKey = rec.entryKey.trim();
  }
  if (artifact.kind === "marked-section" && artifact.markerId === undefined) {
    // Default to the existing Directive section marker when omitted.
    artifact.markerId = MANAGED_SECTION_MARKER_ID;
  }
  return artifact;
}

/**
 * Parse an ownership record from disk JSON (or null if invalid/missing fields).
 * Tolerates legacy freshness fields without requiring or returning them.
 */
export function parseOwnershipRecord(raw: unknown): SetupOwnershipRecord | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const rec = raw as Record<string, unknown>;
  const schemaVersion = rec.schemaVersion;
  if (schemaVersion !== OWNERSHIP_SCHEMA_VERSION) {
    return null;
  }
  if (typeof rec.runtimeVersion !== "string" || !rec.runtimeVersion.trim()) {
    return null;
  }
  if (!isPackageManagerFact(rec.packageManager)) {
    return null;
  }
  if (!Array.isArray(rec.ownership)) {
    return null;
  }
  const ownership: OwnedArtifact[] = [];
  for (const entry of rec.ownership) {
    const parsed = parseOwnedArtifact(entry);
    if (parsed === null) {
      return null;
    }
    ownership.push(parsed);
  }
  return {
    schemaVersion: OWNERSHIP_SCHEMA_VERSION,
    runtimeVersion: rec.runtimeVersion.trim(),
    packageManager: rec.packageManager,
    ownership,
  };
}

/**
 * Build a validated ownership record from caller input. Normalizes paths and
 * sorts ownership entries for stable serialization (AC13.2).
 */
export function buildOwnershipRecord(input: {
  readonly runtimeVersion: string;
  readonly packageManager: PackageManagerFact;
  readonly ownership: readonly OwnedArtifact[];
  readonly schemaVersion?: typeof OWNERSHIP_SCHEMA_VERSION;
}): SetupOwnershipRecord {
  if (typeof input.runtimeVersion !== "string" || !input.runtimeVersion.trim()) {
    throw new Error("runtimeVersion is required");
  }
  if (!isPackageManagerFact(input.packageManager)) {
    throw new Error(`unsupported packageManager fact: ${String(input.packageManager)}`);
  }
  const ownership = input.ownership.map((entry) => {
    const path = normalizeRelativePath(entry.path);
    if (!isOwnershipKind(entry.kind)) {
      throw new Error(`unsupported ownership kind: ${String(entry.kind)}`);
    }
    if (typeof entry.fingerprint !== "string" || !entry.fingerprint.trim()) {
      throw new Error(`fingerprint required for ${path}`);
    }
    const out: OwnedArtifact = {
      path,
      kind: entry.kind,
      fingerprint: entry.fingerprint.trim(),
      ...(entry.markerId !== undefined && entry.markerId.trim()
        ? { markerId: entry.markerId.trim() }
        : entry.kind === "marked-section"
          ? { markerId: MANAGED_SECTION_MARKER_ID }
          : {}),
      ...(entry.entryKey !== undefined && entry.entryKey.trim()
        ? { entryKey: entry.entryKey.trim() }
        : {}),
    };
    return out;
  });
  ownership.sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    const ak = a.entryKey ?? a.markerId ?? "";
    const bk = b.entryKey ?? b.markerId ?? "";
    if (ak !== bk) return ak < bk ? -1 : 1;
    return a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0;
  });
  return {
    schemaVersion: OWNERSHIP_SCHEMA_VERSION,
    runtimeVersion: input.runtimeVersion.trim(),
    packageManager: input.packageManager,
    ownership,
  };
}

/** Canonical JSON used for stable equality (excludes legacy timestamp fields). */
function canonicalOwnershipJson(record: SetupOwnershipRecord): string {
  const stable = buildOwnershipRecord(record);
  return JSON.stringify({
    schemaVersion: stable.schemaVersion,
    runtimeVersion: stable.runtimeVersion,
    packageManager: stable.packageManager,
    ownership: stable.ownership.map((o) => {
      const entry: Record<string, string> = {
        path: o.path,
        kind: o.kind,
        fingerprint: o.fingerprint,
      };
      if (o.markerId !== undefined) entry.markerId = o.markerId;
      if (o.entryKey !== undefined) entry.entryKey = o.entryKey;
      return entry;
    }),
  });
}

/**
 * Stable fingerprint of an ownership record for AC13.2 equality.
 * Strips legacy stampedAt/stampedBy/generation-style fields by construction.
 */
export function stableOwnershipFingerprint(record: SetupOwnershipRecord): string {
  return fingerprintContent(canonicalOwnershipJson(record));
}

/** True when two records are equal under AC13.2 (ignore per-run legacy fields). */
export function ownershipRecordsEqual(a: SetupOwnershipRecord, b: SetupOwnershipRecord): boolean {
  return stableOwnershipFingerprint(a) === stableOwnershipFingerprint(b);
}

/** Read the ownership record from a project root (null when absent/unreadable). */
export function readOwnershipRecord(projectRoot: string): SetupOwnershipRecord | null {
  const inspection = inspectOwnershipRecord(projectRoot);
  return inspection.kind === "valid" ? inspection.record : null;
}

/** Distinguish missing vs invalid vs valid ownership records. */
export function inspectOwnershipRecord(projectRoot: string): OwnershipInspection {
  const path = generationPath(projectRoot);
  if (!existsSync(path)) {
    return { kind: "absent" };
  }
  try {
    const raw = readFileSync(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { kind: "unreadable", reason: "invalid-json" };
    }
    const record = parseOwnershipRecord(parsed);
    if (record === null) {
      return { kind: "unreadable", reason: "invalid-record" };
    }
    return { kind: "valid", record, raw };
  } catch {
    return { kind: "unreadable", reason: "invalid-json" };
  }
}

/**
 * Read the legacy/live `generation` integer from GENERATION.json when present.
 * Used as conversion evidence (AC10.5 / AC10.9); returns 0 when absent/invalid.
 */
export function readEvidenceGenerationNumber(projectRoot: string): number {
  const path = generationPath(projectRoot);
  if (!existsSync(path)) return 0;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return 0;
    }
    const generation = (parsed as { generation?: unknown }).generation;
    if (typeof generation === "number" && Number.isSafeInteger(generation) && generation >= 1) {
      return generation;
    }
  } catch {
    /* absent/invalid */
  }
  return 0;
}

/**
 * Write the stable ownership record (AC13.2 fields). Idempotent when the
 * on-disk ownership fingerprint already matches — avoids dirty trees.
 * Optional `generation` is written for AC10.9 old-CLI defence on conversion;
 * it is not part of the stable ownership fingerprint.
 */
export function writeOwnershipRecord(
  projectRoot: string,
  record: SetupOwnershipRecord,
  options?: { readonly generation?: number },
): string {
  const root = resolve(projectRoot);
  const target = generationPath(projectRoot);
  const stable = buildOwnershipRecord(record);
  const payload: Record<string, unknown> = {
    schemaVersion: stable.schemaVersion,
    runtimeVersion: stable.runtimeVersion,
    packageManager: stable.packageManager,
    ownership: stable.ownership.map((o) => {
      const entry: Record<string, string> = {
        path: o.path,
        kind: o.kind,
        fingerprint: o.fingerprint,
      };
      if (o.markerId !== undefined) entry.markerId = o.markerId;
      if (o.entryKey !== undefined) entry.entryKey = o.entryKey;
      return entry;
    }),
  };
  if (
    options?.generation !== undefined &&
    Number.isSafeInteger(options.generation) &&
    options.generation >= 1
  ) {
    payload.generation = options.generation;
  }
  const body = `${JSON.stringify(payload, null, 2)}\n`;

  const prior = readOwnershipRecord(projectRoot);
  const forceGeneration =
    options?.generation !== undefined &&
    Number.isSafeInteger(options.generation) &&
    options.generation >= 1 &&
    readEvidenceGenerationNumber(projectRoot) !== options.generation;
  if (prior !== null && ownershipRecordsEqual(prior, stable) && !forceGeneration) {
    // Already current: do not rewrite (AC13.2 + dirty-tree avoidance).
    return target;
  }

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
