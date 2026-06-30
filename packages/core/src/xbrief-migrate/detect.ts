import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  LEGACY_ARTIFACT_DIR,
  LEGACY_ARTIFACT_SUFFIX,
  LEGACY_INFO_ROOT_KEY,
  LEGACY_VBRIEF_VERSION,
  MIGRATED_ARTIFACT_DIR,
  VBRIEF_REFERENCE_PREFIX,
} from "./constants.js";

/** Structured result of a legacy vbrief layout probe (#2108 / #2034). */
export interface LegacyVbriefLayoutDetection {
  legacyLayout: boolean;
  reasons: string[];
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function safeReadText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function walkJsonFiles(root: string, acc: string[] = []): string[] {
  if (!isDirectory(root)) {
    return acc;
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      walkJsonFiles(full, acc);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      acc.push(full);
    }
  }
  return acc;
}

function scanFileContent(path: string, content: string, reasons: Set<string>): void {
  if (path.endsWith(LEGACY_ARTIFACT_SUFFIX)) {
    reasons.add(`legacy artifact filename: ${path}`);
  }
  if (content.includes(`"${LEGACY_INFO_ROOT_KEY}"`)) {
    reasons.add(`legacy info root key in ${path}`);
  }
  if (content.includes(`"version": "${LEGACY_VBRIEF_VERSION}"`)) {
    reasons.add(`declared version ${LEGACY_VBRIEF_VERSION} in ${path}`);
  }
  if (content.includes(VBRIEF_REFERENCE_PREFIX)) {
    reasons.add(`legacy reference prefix ${VBRIEF_REFERENCE_PREFIX} in ${path}`);
  }
}

/**
 * Detect whether `projectRoot` still uses the legacy vbrief on-disk layout.
 * Mirrors the structured-reasons pattern from `detectPreCutover` (#793).
 */
export function detectLegacyVbriefLayout(projectRoot: string): LegacyVbriefLayoutDetection {
  const reasons = new Set<string>();

  const legacyRoot = join(projectRoot, LEGACY_ARTIFACT_DIR);
  const migratedRoot = join(projectRoot, MIGRATED_ARTIFACT_DIR);

  if (isDirectory(legacyRoot)) {
    reasons.add(`${LEGACY_ARTIFACT_DIR}/ directory present`);
    for (const jsonPath of walkJsonFiles(legacyRoot)) {
      scanFileContent(jsonPath, safeReadText(jsonPath), reasons);
    }
  }

  if (isDirectory(migratedRoot)) {
    for (const jsonPath of walkJsonFiles(migratedRoot)) {
      scanFileContent(jsonPath, safeReadText(jsonPath), reasons);
    }
  }

  // Root-level legacy artifacts (unusual but covered by acceptance probes).
  if (existsSync(projectRoot) && isDirectory(projectRoot)) {
    for (const entry of readdirSync(projectRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(LEGACY_ARTIFACT_SUFFIX)) {
        continue;
      }
      const full = join(projectRoot, entry.name);
      scanFileContent(full, safeReadText(full), reasons);
    }
  }

  const reasonList = [...reasons];
  return { legacyLayout: reasonList.length > 0, reasons: reasonList };
}
