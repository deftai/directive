import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  resolveLifecycleLayout,
  resolveLifecycleRoot,
  resolveSpecArtifactPath,
} from "../layout/resolve.js";
import {
  contentHasGeneratedSpecSource,
  GENERATED_SPEC_PURPOSE,
} from "../spec-authority/constants.js";
import { isFullSpecState, isGreenfieldSpecExport } from "../spec-authority/resolver.js";
import { DEPRECATION_SENTINEL } from "../vbrief-build/constants.js";

export { DEPRECATION_SENTINEL as DEPRECATED_REDIRECT_SENTINEL };

const DEPRECATION_REDIRECT_PURPOSE = "<!-- Purpose: deprecation redirect -->";

const LIFECYCLE_FOLDERS = ["proposed", "pending", "active", "completed", "cancelled"] as const;

export function missingLifecycleFolders(projectRoot: string): string[] {
  const lifecycleRoot = resolveLifecycleRoot(projectRoot);
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
  return (
    content.includes(GENERATED_SPEC_PURPOSE) &&
    contentHasGeneratedSpecSource(content) &&
    existsSync(resolveSpecArtifactPath(projectRoot))
  );
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

  const layout = resolveLifecycleLayout(projectRoot);
  if (existsSync(layout.root)) {
    const missing = missingLifecycleFolders(projectRoot);
    if (missing.length > 0) {
      reasons.push(`${layout.artifactDir}/ is missing lifecycle folder(s): ${missing.join(", ")}`);
    }
  }

  return { preCutover: reasons.length > 0, reasons };
}

/** Last release that ships `scripts/migrate_vbrief.py` on the consumer deposit path (#2068). */
export const FROZEN_PRECUTOVER_MIGRATION_TAG = "v0.59.0";

export function frozenPreCutoverMigrationGuidance(): string {
  return (
    `Current npm releases no longer ship in-product \`task migrate:vbrief\`. Pin framework ${FROZEN_PRECUTOVER_MIGRATION_TAG} ` +
    `(frozen Go installer or git tag), install Python 3.11+ and uv, run \`task migrate:vbrief\` once from that payload, ` +
    `then upgrade to current npm. See UPGRADING.md § Frozen pre-v0.20 document-model migration (#2068).`
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
