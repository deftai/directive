import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  assertProjectionContained,
  ProjectionContainmentError,
} from "../fs/projection-containment.js";
import { AGENTS_MANAGED_CLOSE } from "../platform/constants.js";
import { findManagedOpenMarker } from "../platform/linear-scan.js";
import { parseManifestKeyValueLine, stripEdgeQuotes } from "../text/redos-safe.js";
import { readTextSafe } from "./paths.js";

export function parseManifest(text: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const row = parseManifestKeyValueLine(line);
    if (row === null) {
      continue;
    }
    parsed[row.key] = row.value;
  }
  return parsed;
}

export function parseInstallManifest(text: string): Record<string, string> {
  const data: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const stripped = line.trim();
    if (!stripped || !stripped.includes(":")) {
      continue;
    }
    const colon = stripped.indexOf(":");
    const k = stripped.slice(0, colon).trim();
    let v = stripped.slice(colon + 1).trim();
    v = stripEdgeQuotes(v);
    if (k) {
      data[k] = v;
    }
  }
  return data;
}

export function manifestTagToVersion(manifest: Record<string, string>): string | null {
  for (const key of ["tag", "ref"]) {
    const raw = manifest[key];
    if (typeof raw !== "string") {
      continue;
    }
    const candidate = raw.trim().replace(/^v/, "");
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

/** Reportability classes for an install manifest's version provenance (#2294). */
export type ManifestVersionSource = "tag" | "ref" | "sha" | "none";

export interface ReportableVersion {
  /** Semver derived from `tag`/`ref` (leading `v` stripped), else null. */
  readonly version: string | null;
  /** Recorded commit `sha`, trimmed, else null. */
  readonly sha: string | null;
  /** Where a reportable identity was found. */
  readonly source: ManifestVersionSource;
}

/**
 * Classify what a manifest can report as its version (#2294). A legacy
 * `deft-install` deposit made without a release pin writes empty `tag`/`ref`
 * and only a short `sha`; `manifestTagToVersion` then returns null and the
 * version is silently unreportable. This helper distinguishes a pinned
 * semver (`tag`/`ref`) from a sha-only deposit from a manifest with no
 * provenance at all, so callers can surface an actionable signal instead of a
 * blank.
 */
export function manifestReportableVersion(manifest: Record<string, string>): ReportableVersion {
  const version = manifestTagToVersion(manifest);
  if (version !== null) {
    const tag = typeof manifest.tag === "string" ? manifest.tag.trim() : "";
    return { version, sha: readSha(manifest), source: tag ? "tag" : "ref" };
  }
  const sha = readSha(manifest);
  return { version: null, sha, source: sha !== null ? "sha" : "none" };
}

function readSha(manifest: Record<string, string>): string | null {
  const raw = typeof manifest.sha === "string" ? manifest.sha.trim() : "";
  return raw || null;
}

export function manifestCandidatePaths(projectRoot: string, installRoot: string | null): string[] {
  const raw: string[] = [];
  if (installRoot) {
    raw.push(join(projectRoot, installRoot, "VERSION"));
  }
  raw.push(join(projectRoot, ".deft", "core", "VERSION"));
  raw.push(join(projectRoot, ".deft", "VERSION"));
  raw.push(join(projectRoot, "deft", "VERSION"));
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const candidate of raw) {
    if (!seen.has(candidate)) {
      seen.add(candidate);
      ordered.push(candidate);
    }
  }
  return ordered;
}

export function locateManifest(
  projectRoot: string,
  installRoot: string | null,
  isFile: (p: string) => boolean = existsSync,
): string | null {
  for (const candidate of manifestCandidatePaths(projectRoot, installRoot)) {
    if (isFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

const INSTALLED_IN_RE = /Deft is installed in\s+(\S+?)\/?\./;
const FULL_GUIDELINES_RE = /Full guidelines:\s+(\S+)\/main\.md/;

export function parseInstallRootFromAgentsMd(text: string): string | null {
  let match = INSTALLED_IN_RE.exec(text);
  if (match?.[1]) {
    return match[1].trim();
  }
  match = FULL_GUIDELINES_RE.exec(text);
  if (match?.[1]) {
    return match[1].trim();
  }
  return null;
}

/** Fallback when an AGENTS.md install-root is missing or fails containment (#4162). */
export const FALLBACK_INSTALL_ROOT = ".deft/core";

/**
 * Contain an AGENTS.md install-root before any probe or echo (#4162).
 * Rejects `..`, absolute paths, and escaping symlinks; falls back to `.deft/core`.
 */
export function containDepositInstallRoot(
  projectRoot: string,
  raw: string | null | undefined,
): string {
  if (raw == null) return FALLBACK_INSTALL_ROOT;
  const trimmed = raw.trim();
  if (!trimmed) return FALLBACK_INSTALL_ROOT;
  if (isAbsolute(trimmed)) return FALLBACK_INSTALL_ROOT;
  const posix = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!posix || posix.split("/").includes("..")) return FALLBACK_INSTALL_ROOT;
  const projectAbs = resolve(projectRoot);
  const resolved = resolve(projectAbs, posix);
  const rel = relative(projectAbs, resolved);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return FALLBACK_INSTALL_ROOT;
  try {
    assertProjectionContained(projectAbs, resolved);
  } catch (err) {
    if (err instanceof ProjectionContainmentError) return FALLBACK_INSTALL_ROOT;
    return FALLBACK_INSTALL_ROOT;
  }
  return posix;
}

/**
 * Canonical v2/v3 managed section for layout detect (#1912 / #4090).
 * Uses the platform linear scanner; v1 is pre-v0.27 (Go-bridge), not a
 * writable npm section. Freshness classification stays on agentsRefreshPlan.
 */
export function extractManagedSection(text: string): string | null {
  const normalised = text.replace(/\r\n/g, "\n");
  let pos = 0;
  while (pos < normalised.length) {
    const open = findManagedOpenMarker(normalised, pos);
    if (open === null) return null;
    if (open.version >= 2) {
      const closeIdx = normalised.indexOf(AGENTS_MANAGED_CLOSE, open.end);
      if (closeIdx < 0) return null;
      return normalised.slice(open.start, closeIdx + AGENTS_MANAGED_CLOSE.length);
    }
    pos = open.end;
  }
  return null;
}

export function isDeprecationRedirectStub(text: string): boolean {
  const lines = text.replace(/\r\n/g, "\n").trimStart().split("\n");
  const sentinels = new Set([
    "<!-- deft:deprecated-redirect -->",
    "<!-- deft:deprecated-skill-redirect -->",
  ]);
  return lines.slice(0, 8).some((line) => sentinels.has(line.trim()));
}

export function readManifestAt(path: string | null, readText = readTextSafe): string | null {
  if (!path) {
    return null;
  }
  return readText(path);
}
