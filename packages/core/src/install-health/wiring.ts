/**
 * Cheap structural wiring checks for AC2.1 predicate (5).
 *
 * Wave 2c: probes package-relative managed surfaces. If a file is present, its
 * Directive-owned content must target RUNTIME_PACKAGE_PATH_PREFIX (not
 * `.deft/core/` or bare `deft-hook`). Absent files are not failures — hosts
 * may opt out; presence of mismatched content fails.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_PACKAGE_PATH_PREFIX } from "./constants.js";
import {
  MANAGED_SECTION_CLOSE,
  MANAGED_SECTION_OPEN_PREFIX,
  MANAGED_SECTION_MARKER_ID,
} from "./ownership.js";
import type { FsSeams } from "./readers.js";

export interface WiringCheckResult {
  readonly ok: boolean;
  readonly reason: string | null;
  /** Paths that were present and inspected. */
  readonly inspected: readonly string[];
  /** Paths that failed the runtime-prefix check. */
  readonly mismatched: readonly string[];
}

/**
 * Relative paths probed when present (Wave 2c inventory).
 * Marker convention remains deft:managed-section for AGENTS.
 */
export const WIRING_PROBE_RELS: readonly string[] = [
  "AGENTS.md",
  ".agents/skills/deft/SKILL.md",
  ".claude/settings.json",
  ".cursor/hooks.json",
  ".codex/hooks.json",
  ".grok/hooks/deft.json",
  "Taskfile.yml",
  ".githooks/pre-commit",
  ".githooks/_directive-run.sh",
];

/** Exported so callers/docs can assert the marker id has not drifted. */
export const WIRING_MANAGED_SECTION_MARKER = MANAGED_SECTION_MARKER_ID;

function defaultIsFile(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

function defaultReadText(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Extract `<!-- deft:managed-section … -->` … `<!-- /deft:managed-section -->`. */
function extractManagedSection(text: string): string | null {
  const start = text.indexOf(MANAGED_SECTION_OPEN_PREFIX);
  if (start < 0) return null;
  const openEnd = text.indexOf("-->", start);
  if (openEnd < 0) return null;
  const end = text.indexOf(MANAGED_SECTION_CLOSE, openEnd);
  if (end < 0) return null;
  return text.slice(start, end + MANAGED_SECTION_CLOSE.length);
}

function targetsRuntime(
  text: string,
  options: { readonly allowDeftHookProse?: boolean } = {},
): boolean {
  const prefix = RUNTIME_PACKAGE_PATH_PREFIX.replace(/\/$/, "");
  if (!text.includes(prefix)) return false;
  if (text.includes(".deft/core/")) return false;
  // Hook JSON / skill pointers must not invoke bare deft-hook. AGENTS managed
  // prose may name it when teaching recovery (agents-entry.md).
  if (
    !options.allowDeftHookProse &&
    /(^|[\s"`'])deft-hook([\s"`']|$)/.test(text)
  ) {
    return false;
  }
  return true;
}

/** Pre-commit/pre-push only source the helper; runtime path lives in the helper. */
function isGitHookShim(rel: string, text: string): boolean {
  if (rel !== ".githooks/pre-commit" && rel !== ".githooks/pre-push") return false;
  if (text.includes(".deft/core/")) return false;
  if (/(^|[\s"`'])deft-hook([\s"`']|$)/.test(text)) return false;
  return text.includes("_directive-run.sh");
}

function inspectProbe(rel: string, text: string): boolean {
  if (rel === "AGENTS.md") {
    const section = extractManagedSection(text);
    if (section === null) {
      // File present without a managed section — not Directive wiring yet.
      return true;
    }
    return targetsRuntime(section, { allowDeftHookProse: true });
  }
  if (isGitHookShim(rel, text)) return true;
  return targetsRuntime(text);
}

/**
 * True when at least one probe shows Directive-owned wiring (AC14.20 vs AC14.50).
 * AGENTS.md counts only with a managed section targeting the runtime prefix;
 * other probes count when they target the runtime prefix or are git-hook shims.
 */
export function hasDirectiveWiringEvidence(
  projectRoot: string,
  seams: FsSeams = {},
): boolean {
  const isFile = seams.isFile ?? defaultIsFile;
  const readText = seams.readText ?? defaultReadText;
  for (const rel of WIRING_PROBE_RELS) {
    const path = join(projectRoot, rel);
    if (!isFile(path)) continue;
    const text = readText(path);
    if (text === null) continue;
    if (rel === "AGENTS.md") {
      const section = extractManagedSection(text);
      if (section !== null && targetsRuntime(section)) return true;
      continue;
    }
    if (isGitHookShim(rel, text) || targetsRuntime(text)) return true;
  }
  return false;
}

/**
 * Structural wiring check against the Wave 2c probe inventory.
 * Missing probes do not fail. Present mismatched probes fail.
 */
export function checkWiringTargetsRuntime(
  projectRoot: string,
  seams: FsSeams = {},
): WiringCheckResult {
  const isFile = seams.isFile ?? defaultIsFile;
  const readText = seams.readText ?? defaultReadText;
  const inspected: string[] = [];
  const mismatched: string[] = [];

  for (const rel of WIRING_PROBE_RELS) {
    const path = join(projectRoot, rel);
    if (!isFile(path)) continue;
    inspected.push(rel);
    const text = readText(path);
    if (text === null) {
      mismatched.push(rel);
      continue;
    }
    if (!inspectProbe(rel, text)) {
      mismatched.push(rel);
    }
  }

  if (mismatched.length > 0) {
    return {
      ok: false,
      reason: `wiring does not target ${RUNTIME_PACKAGE_PATH_PREFIX}: ${mismatched.join(", ")}`,
      inspected,
      mismatched,
    };
  }

  return {
    ok: true,
    reason: null,
    inspected,
    mismatched: [],
  };
}
