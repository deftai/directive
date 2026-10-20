import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveLifecycleLayout, resolveLifecycleRoot } from "../layout/resolve.js";
import { GENERATED_SPEC_PURPOSE } from "../spec-authority/constants.js";
import {
  contentHasResolvedSpecSource,
  isFullSpecState,
  isGreenfieldSpecExport,
} from "../spec-authority/resolver.js";
import { DEPRECATION_SENTINEL } from "../vbrief-build/constants.js";

export { DEPRECATION_SENTINEL as DEPRECATED_REDIRECT_SENTINEL };

const DEPRECATION_REDIRECT_PURPOSE = "<!-- Purpose: deprecation redirect -->";

const LIFECYCLE_FOLDERS = ["proposed", "pending", "active", "completed", "cancelled"] as const;

export function missingLifecycleFolders(projectRoot: string): string[] {
  let lifecycleRoot: string;
  try {
    lifecycleRoot = resolveLifecycleRoot(projectRoot);
  } catch {
    // No xbrief/ layout present -- all lifecycle folders are missing.
    return [...LIFECYCLE_FOLDERS];
  }
  return LIFECYCLE_FOLDERS.filter((folder) => !existsSync(join(lifecycleRoot, folder)));
}

function hasCompleteLifecycle(projectRoot: string): boolean {
  return missingLifecycleFolders(projectRoot).length === 0;
}

/** Return true when markdown content is a migration redirect stub. */
export function isDeprecationRedirect(content: string): boolean {
  return content.includes(DEPRECATION_SENTINEL) || content.includes(DEPRECATION_REDIRECT_PURPOSE);
}

/** Full-spec generated export (layout-resolved specification artifact source line). */
export function isGeneratedSpecificationExport(projectRoot: string, content: string): boolean {
  if (!content.includes(GENERATED_SPEC_PURPOSE)) {
    return false;
  }
  return contentHasResolvedSpecSource(projectRoot, content);
}

/** Return true for a fully current generated spec export (full-spec or greenfield). */
export function isCurrentGeneratedSpecification(projectRoot: string, content: string): boolean {
  if (!hasCompleteLifecycle(projectRoot)) return false;
  if (isGeneratedSpecificationExport(projectRoot, content)) return true;
  return isGreenfieldSpecExport(projectRoot);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
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

function rootMarkdownIsLegacy(projectRoot: string, filename: string, content: string): boolean {
  if (isDeprecationRedirect(content)) return false;
  if (filename === "SPECIFICATION.md") {
    if (isGeneratedSpecificationExport(projectRoot, content)) return false;
    if (isGreenfieldSpecExport(projectRoot)) return false;
    if (isFullSpecState(projectRoot)) return false;
  }
  return filename === "SPECIFICATION.md" || filename === "PROJECT.md";
}

/** Return root artifact filenames that are legacy pre-v0.20 inputs (#793 / migrate preflight). */
export function detectPreCutoverLegacy(projectRoot: string): string[] {
  const legacy: string[] = [];
  for (const filename of ["SPECIFICATION.md", "PROJECT.md"] as const) {
    const candidate = join(projectRoot, filename);
    if (!isFile(candidate)) continue;
    const content = safeReadText(candidate);
    if (rootMarkdownIsLegacy(projectRoot, filename, content)) {
      legacy.push(filename);
    }
  }
  return legacy;
}

/** Structured result of a pre-cutover (pre-v0.20 document model) probe. */
export interface PrecutoverDetection {
  preCutover: boolean;
  reasons: string[];
}

export function detectPreCutover(projectRoot: string): PrecutoverDetection {
  const reasons: string[] = [];

  const specPath = join(projectRoot, "SPECIFICATION.md");
  if (isFile(specPath)) {
    const content = safeReadText(specPath);
    if (!isDeprecationRedirect(content) && !isCurrentGeneratedSpecification(projectRoot, content)) {
      reasons.push(
        "SPECIFICATION.md is a pre-v0.20 hand-authored doc (not a deprecation redirect or current generated export)",
      );
    }
  }

  const projectMdPath = join(projectRoot, "PROJECT.md");
  if (isFile(projectMdPath)) {
    const content = safeReadText(projectMdPath);
    if (!isDeprecationRedirect(content)) {
      reasons.push("PROJECT.md is a pre-v0.20 hand-authored doc (not a deprecation redirect)");
    }
  }

  // Since #2112, resolveLifecycleLayout throws when no xbrief/ layout is present.
  // Catch that error so the doctor can still diagnose pre-cutover state on unmigrated trees.
  // However, an empty (greenfield) directory with no pre-cutover artifacts is NOT pre-cutover.
  let layout: ReturnType<typeof resolveLifecycleLayout> | null = null;
  try {
    layout = resolveLifecycleLayout(projectRoot);
  } catch {
    // No xbrief/ layout found. Only report a pre-cutover reason if legacy artifacts
    // (SPECIFICATION.md / PROJECT.md) were already detected above; a bare empty directory
    // without any artifacts is greenfield, not pre-cutover.
    if (reasons.length > 0) {
      reasons.push("xbrief/ lifecycle layout not found -- run `directive upgrade`");
    }
    return { preCutover: reasons.length > 0, reasons };
  }
  if (existsSync(layout.root)) {
    const missing = missingLifecycleFolders(projectRoot);
    if (missing.length > 0) {
      reasons.push(`${layout.artifactDir}/ is missing lifecycle folder(s): ${missing.join(", ")}`);
    }
  }

  return { preCutover: reasons.length > 0, reasons };
}

/** Historical tag that last shipped `scripts/migrate_vbrief.py` (#2068); not taught as recovery. */
export const FROZEN_PRECUTOVER_MIGRATION_TAG = "v0.59.0";

/**
 * Doctor next-step for pre-cutover / data-behind (AC8.9 / F-017).
 * Teach `directive upgrade` — not frozen `task migrate:vbrief` / `deft migrate:xbrief` recipes.
 */
export function frozenPreCutoverMigrationGuidance(): string {
  return (
    `Pre-v0.20 hand-authored root docs and legacy lifecycle layouts are recovered through ` +
    `installation management: run \`directive upgrade\` so the pinned runtime can migrate ` +
    `supported envelopes to current xbrief/ (and archive unknowable files under xbrief/archive/). ` +
    `Diagnostic note: the last release that shipped an in-tree \`task migrate:vbrief\` helper was ` +
    `${FROZEN_PRECUTOVER_MIGRATION_TAG}; that two-hop recipe is no longer the taught path. ` +
    `If upgrade cannot recover your content, \`directive init\` a fresh project and hand-port. ` +
    `See UPGRADING.md (#2068) for historical context only.`
  );
}

export function renderPrecutoverLine(projectRoot: string): string {
  const { preCutover, reasons } = detectPreCutover(projectRoot);
  if (!preCutover) {
    return "Pre-cutover: none -- project is on the current vBRIEF document model.";
  }
  const summary = reasons.join("; ").replace(/\r?\n/g, " ");
  return `Pre-cutover: migration needed -- ${summary}. ${frozenPreCutoverMigrationGuidance()}`;
}

// Re-export for classify callers (#2013).
export { isFullSpecState, isGreenfieldSpecExport };
