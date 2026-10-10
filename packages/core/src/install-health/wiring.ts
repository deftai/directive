/**
 * Cheap structural wiring checks for AC2.1 predicate (5).
 *
 * Wave 2c owns full package-relative wiring migration. Until then this module
 * probes a small set of known managed surfaces: if a file is present, its
 * Directive-owned content must target RUNTIME_PACKAGE_PATH_PREFIX (not
 * `.deft/core/` or bare `deft-hook`). Absent files are not failures — the
 * required-wiring inventory is incomplete until 2c.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_PACKAGE_PATH_PREFIX } from "./constants.js";
import {
  MANAGED_SECTION_CLOSE,
  MANAGED_SECTION_OPEN_PREFIX,
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

/** Relative paths probed when present (stubs until 2c expands the inventory). */
export const WIRING_PROBE_RELS: readonly string[] = ["AGENTS.md"];

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

function sectionTargetsRuntime(section: string): boolean {
  // Version-free package prefix (with or without trailing slash in pointers).
  const prefix = RUNTIME_PACKAGE_PATH_PREFIX.replace(/\/$/, "");
  if (!section.includes(prefix)) return false;
  // Fail closed on legacy copy / bare hook targets inside the managed section.
  if (section.includes(".deft/core/")) return false;
  if (/(^|[\s"`'])deft-hook([\s"`']|$)/.test(section)) return false;
  return true;
}

/**
 * Structural wiring check. Documents stub scope: only AGENTS.md managed
 * section today; missing probes do not fail. Present mismatched probes fail.
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
    const section = extractManagedSection(text);
    if (section === null) {
      // File present without a managed section — not Directive wiring yet.
      continue;
    }
    if (!sectionTargetsRuntime(section)) {
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
